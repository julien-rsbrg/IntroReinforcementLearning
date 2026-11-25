"""FastAPI server: one Frozen Lake + Q-learning session per browser tab."""

from __future__ import annotations

import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .evaluation import TRAIN_STEPS, EvalBody, evaluate, random_baseline
from .frozen_lake_yeti import ASSETS_DIR, PRESETS, FrozenLakeYeti, default_reward_grid, validate_desc
from .qlearning import QLearningAgent

STATIC_DIR = Path(__file__).resolve().parent / "static"


MAX_SESSIONS = 500
SESSION_TTL = 6 * 3600
MAX_TRAIN_EPISODES = 20000
MAX_TRAIN_STEPS = 100_000  # keeps one /api/train call to a few seconds
HISTORY_LEN = 2000


class Session:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.last_used = time.time()
        self.desc = PRESETS["Classic 4×4"]
        self.rewards = default_reward_grid(self.desc)
        self.slippery = False
        self.hyper = dict(alpha=0.5, gamma=0.95, epsilon=0.2, epsilon_decay=1.0, epsilon_min=0.01)
        self.agent = QLearningAgent(len(self.desc) * len(self.desc[0]), **self.hyper)
        self._build_env()

    def _build_env(self) -> None:
        self.env = FrozenLakeYeti(self.desc, is_slippery=self.slippery, reward_map=self.rewards)
        self.env.reset()
        self.done = False
        self.ep_return = 0.0
        self.ep_steps = 0
        self.episode = 0
        self.history: list[dict] = []

    def reset_episode(self) -> None:
        self.env.reset()
        self.done = False
        self.ep_return = 0.0
        self.ep_steps = 0

    def step(self) -> dict:
        if self.done:
            self.reset_episode()
        s = self.env.state
        a, explored = self.agent.act(s)
        epsilon = self.agent.epsilon
        s2, r, terminated, truncated, _ = self.env.step(a)
        upd = self.agent.update(s, a, r, int(s2), terminated)
        self.ep_return += r
        self.ep_steps += 1
        self.done = terminated or truncated
        tr = dict(
            s=s, a=a, r=r, s2=int(s2), terminated=terminated, truncated=truncated,
            explored=explored, epsilon=epsilon, alpha=self.agent.alpha, gamma=self.agent.gamma,
            step=self.ep_steps, ep_return=self.ep_return, **upd,
        )
        if self.done:
            tr["outcome"] = self.env.last_outcome
            self._finish_episode()
        return tr

    def _finish_episode(self) -> None:
        self.episode += 1
        self.history.append(
            {"ret": round(self.ep_return, 4), "ok": self.env.last_outcome == "goal", "len": self.ep_steps}
        )
        del self.history[:-HISTORY_LEN]
        self.agent.end_episode()

    def run_episode(self) -> list[dict]:
        if self.done:
            self.reset_episode()
        out = [self.step()]
        while not self.done:
            out.append(self.step())
        return out

    def state(self) -> dict:
        return dict(
            desc=self.desc,
            rewards=self.rewards,
            slippery=self.slippery,
            hyper={**self.hyper, "epsilon": self.agent.epsilon},
            q=self.agent.Q.round(5).tolist(),
            pos=self.env.state,
            done=self.done,
            outcome=self.env.last_outcome,
            episode=self.episode,
            ep_steps=self.ep_steps,
            ep_return=self.ep_return,
            history=self.history,
            max_steps=self.env.env.spec.max_episode_steps,
        )


SESSIONS: dict[str, Session] = {}
SESSIONS_LOCK = threading.Lock()


def get_session(sid: str) -> Session:
    now = time.time()
    with SESSIONS_LOCK:
        for k in [k for k, v in SESSIONS.items() if now - v.last_used > SESSION_TTL]:
            del SESSIONS[k]
        sess = SESSIONS.get(sid)
        if sess is None:
            if len(SESSIONS) >= MAX_SESSIONS:
                oldest = min(SESSIONS, key=lambda k: SESSIONS[k].last_used)
                del SESSIONS[oldest]
            sess = SESSIONS[sid] = Session()
        sess.last_used = now
        return sess


app = FastAPI(title="Frozen Lake – Tabular Q-learning")


class SidBody(BaseModel):
    sid: str = Field(min_length=8, max_length=64)


class ConfigBody(SidBody):
    desc: list[str] | None = None
    rewards: list[list[float]] | None = None
    slippery: bool | None = None
    alpha: float | None = Field(None, ge=0, le=1)
    gamma: float | None = Field(None, ge=0, le=1)
    epsilon: float | None = Field(None, ge=0, le=1)
    epsilon_decay: float | None = Field(None, ge=0.5, le=1)
    epsilon_min: float | None = Field(None, ge=0, le=1)


class TrainBody(SidBody):
    n: int = Field(100, ge=1, le=MAX_TRAIN_EPISODES)


@app.get("/api/presets")
def presets():
    return PRESETS


@app.post("/api/state")
def api_state(body: SidBody):
    s = get_session(body.sid)
    with s.lock:
        return s.state()


@app.post("/api/config")
def api_config(body: ConfigBody):
    s = get_session(body.sid)
    with s.lock:
        rebuild = size_changed = False
        if body.desc is not None:
            if not (2 <= len(body.desc) <= 10 and 2 <= len(body.desc[0]) <= 10):
                raise HTTPException(400, "Maps must be between 2×2 and 10×10.")
            try:
                desc = validate_desc(body.desc)
            except ValueError as e:
                raise HTTPException(400, str(e)) from e
            size_changed = (len(desc), len(desc[0])) != (len(s.desc), len(s.desc[0]))
            s.desc = desc
            if size_changed:
                s.agent = QLearningAgent(len(desc) * len(desc[0]), **s.hyper)
                s.rewards = default_reward_grid(desc)
            rebuild = True
        if body.rewards is not None:
            if len(body.rewards) != len(s.desc) or any(len(r) != len(s.desc[0]) for r in body.rewards):
                raise HTTPException(400, "Reward grid shape does not match the map.")
            s.rewards = [[max(-100.0, min(100.0, float(v))) for v in row] for row in body.rewards]
            if not rebuild:
                s.env.set_reward_map(s.rewards)
        if body.slippery is not None and body.slippery != s.slippery:
            s.slippery = body.slippery
            rebuild = True
        for key in ("alpha", "gamma", "epsilon", "epsilon_decay", "epsilon_min"):
            val = getattr(body, key)
            if val is not None:
                s.hyper[key] = val
                setattr(s.agent, key, val)
        if rebuild:
            history, episode = s.history, s.episode
            s._build_env()
            if not size_changed:  # same Q-table, so the learning curve continues
                s.history, s.episode = history, episode
        return s.state()


@app.post("/api/step")
def api_step(body: SidBody):
    s = get_session(body.sid)
    with s.lock:
        tr = s.step()
        return {"transitions": [tr], "state": s.state()}


@app.post("/api/episode")
def api_episode(body: SidBody):
    s = get_session(body.sid)
    with s.lock:
        trs = s.run_episode()
        return {"transitions": trs, "state": s.state()}


@app.post("/api/train")
def api_train(body: TrainBody):
    s = get_session(body.sid)
    with s.lock:
        start = s.episode
        steps = 0
        if not s.done and s.ep_steps > 0:
            steps += len(s.run_episode())  # finish the episode in progress first
        while s.episode - start < body.n and steps < MAX_TRAIN_STEPS:
            steps += len(s.run_episode())
        return {"state": s.state(), "episodes": s.episode - start, "steps": steps,
                "capped": s.episode - start < body.n}


@app.post("/api/reset_q")
def api_reset_q(body: SidBody):
    s = get_session(body.sid)
    with s.lock:
        s.agent = QLearningAgent(len(s.desc) * len(s.desc[0]), **s.hyper)
        s._build_env()
        return s.state()


@app.post("/api/reset_episode")
def api_reset_episode(body: SidBody):
    s = get_session(body.sid)
    with s.lock:
        s.reset_episode()
        return s.state()


@app.post("/api/evaluate")
def api_evaluate(body: EvalBody):
    return evaluate(body)


@app.get("/api/random_baseline")
def api_random_baseline():
    return {
        "train_steps": TRAIN_STEPS,
        "maps": list(PRESETS),
        **{cond: {name: random_baseline(tuple(desc), slip) for name, desc in PRESETS.items()}
           for cond, slip in (("normal", False), ("slippery", True))},
    }


@app.get("/api/sid")
def new_sid():
    return {"sid": uuid.uuid4().hex}


@app.get("/healthz")
def healthz():
    return {"ok": True}


app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/evaluate")
def evaluate_page():
    return FileResponse(STATIC_DIR / "evaluate.html")
