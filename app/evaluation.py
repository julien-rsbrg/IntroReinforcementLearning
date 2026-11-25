"""Benchmark a Q-learning parameter set on the standard maps.

Protocol, for each map and each repetition (seed):
1. a fresh agent learns for only ``TRAIN_STEPS`` environment steps (episodes restart as needed),
   using the rewards chosen by the user (ice / water / yeti);
2. one test episode is then played greedily (ε = 0, no more learning).

The score of the test episode is the *standard* FrozenLake reward (1 if the yeti is reached,
0 otherwise), so parameter sets that use different reward shaping stay comparable.

The random baseline is the exact probability that a uniformly random policy reaches the yeti
within the episode step limit, computed by dynamic programming on the transition table.
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np
from pydantic import BaseModel, Field

from .frozen_lake_yeti import PRESETS, FrozenLakeYeti
from .qlearning import QLearningAgent

TRAIN_STEPS = 100
MAX_REPEATS = 100


class EvalBody(BaseModel):
    alpha: float = Field(0.5, ge=0, le=1)
    gamma: float = Field(0.95, ge=0, le=1)
    epsilon: float = Field(0.2, ge=0, le=1)
    epsilon_decay: float = Field(1.0, ge=0.5, le=1)
    q_init: float = Field(0.0, ge=-100, le=100)
    reward_ice: float = Field(0.0, ge=-100, le=100)
    reward_water: float = Field(0.0, ge=-100, le=100)
    reward_goal: float = Field(1.0, ge=-100, le=100)
    repeats: int = Field(20, ge=1, le=MAX_REPEATS)


def _reward_grid(desc: list[str], p: EvalBody) -> list[list[float]]:
    by_letter = {"S": p.reward_ice, "F": p.reward_ice, "H": p.reward_water, "G": p.reward_goal, "W": 0.0}
    return [[by_letter[c] for c in row] for row in desc]


def run_once(desc: list[str], slippery: bool, p: EvalBody, seed: int) -> float:
    env = FrozenLakeYeti(desc, is_slippery=slippery, reward_map=_reward_grid(desc, p))
    agent = QLearningAgent(
        env.nrow * env.ncol, alpha=p.alpha, gamma=p.gamma, epsilon=p.epsilon,
        epsilon_decay=p.epsilon_decay, q_init=p.q_init, seed=seed,
    )
    s, _ = env.reset(seed=seed)
    for _ in range(TRAIN_STEPS):
        a, _ = agent.act(s)
        s2, r, terminated, truncated, _ = env.step(a)
        agent.update(s, a, r, s2, terminated)
        s = s2
        if terminated or truncated:
            agent.end_episode()
            s, _ = env.reset()

    # test run: greedy, no learning
    s, _ = env.reset()
    while True:
        s, _, terminated, truncated, _ = env.step(agent.greedy(s))
        if terminated or truncated:
            return 1.0 if env.last_outcome == "goal" else 0.0


@lru_cache(maxsize=None)
def random_baseline(desc: tuple[str, ...], slippery: bool) -> float:
    env = FrozenLakeYeti(list(desc), is_slippery=slippery)
    P = env.unwrapped.P
    n = env.nrow * env.ncol
    horizon = env.env.spec.max_episode_steps
    letters = [env.letter(s) for s in range(n)]
    v = np.zeros(n)  # v[s] = P(reach the yeti within the remaining steps | s)
    for _ in range(horizon):
        new = np.zeros(n)
        for s in range(n):
            if letters[s] in "GHW":
                continue
            total = 0.0
            for a in range(4):
                for prob, s2, _, term in P[s][a]:
                    total += prob * (1.0 if letters[s2] == "G" else (0.0 if term else v[s2]))
            new[s] = total / 4
        v = new
    return float(v["".join(desc).index("S")])


def evaluate(p: EvalBody) -> dict:
    results = {}
    for cond, slippery in (("normal", False), ("slippery", True)):
        rows = []
        for name, desc in PRESETS.items():
            scores = np.array([run_once(desc, slippery, p, seed) for seed in range(p.repeats)])
            rows.append({
                "map": name,
                "mean": float(scores.mean()),
                "sem": float(scores.std(ddof=1) / np.sqrt(len(scores))) if len(scores) > 1 else 0.0,
                "random": random_baseline(tuple(desc), slippery),
            })
        results[cond] = {"maps": rows, "average": float(np.mean([r["mean"] for r in rows]))}
    return {"train_steps": TRAIN_STEPS, "repeats": p.repeats, "params": p.model_dump(), **results}
