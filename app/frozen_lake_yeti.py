"""A Gymnasium wrapper around FrozenLake-v1 with walls, custom rewards and sprite rendering.

Map letters
-----------
S : start (ice)            F : frozen ice
H : water (terminal, the character freezes)
W : wall  (not terminal, the character bumps into it and stays where it is)
G : the yeti (terminal, success)

Rewards
-------
The reward of a transition is the reward attached to the state the agent *arrives in*
(``reward_map[next_state]``). Bumping into a wall or into the border leaves the agent
where it was, so it receives the reward of its current cell again.
"""

from __future__ import annotations

from pathlib import Path

import gymnasium as gym
import numpy as np

ASSETS_DIR = Path(__file__).resolve().parent.parent / "Frozen Lake Game Assets" / "png"

CHARACTERS = ("elf", "penguin", "sea-lion")
ACTIONS = ("left", "down", "right", "up")  # Gymnasium FrozenLake action order

# The 4 standard maps (shown in the map menu and used by the evaluation page)
PRESETS: dict[str, list[str]] = {
    "Classic 4×4": ["SFFF", "FHFH", "FFFH", "HFFG"],
    "Walls 5×5": ["SFFFF", "WWWFH", "FFFFF", "FHWWW", "FFFFG"],
    "Shortcut 6×6": ["SFFFFF", "FHHHHF", "FFFFHF", "HHWFHF", "FFWFFF", "FFWHHG"],
    "Classic 8×8": [
        "SFFFFFFF",
        "FFFFFFFF",
        "FFFHFFFF",
        "FFFFFHFF",
        "FFFHFFFF",
        "FHHFFFHF",
        "FHFFHFHF",
        "FFFHFFFG",
    ],
}

DEFAULT_REWARDS = {"S": 0.0, "F": 0.0, "H": 0.0, "G": 1.0, "W": 0.0}


def default_reward_grid(desc: list[str]) -> list[list[float]]:
    return [[DEFAULT_REWARDS[c] for c in row] for row in desc]


def validate_desc(desc: list[str]) -> list[str]:
    if not desc or not all(desc):
        raise ValueError("The map must not be empty.")
    width = len(desc[0])
    if any(len(row) != width for row in desc):
        raise ValueError("All map rows must have the same length.")
    flat = "".join(desc)
    bad = set(flat) - set("SFHWG")
    if bad:
        raise ValueError(f"Unknown map letters: {sorted(bad)}")
    if flat.count("S") != 1:
        raise ValueError("The map needs exactly one start (S).")
    if flat.count("G") < 1:
        raise ValueError("The map needs at least one yeti (G).")
    return list(desc)


class FrozenLakeYeti(gym.Wrapper):
    """FrozenLake with walls, a per-state reward map and a nicer sprite renderer."""

    metadata = {"render_modes": ["rgb_array"], "render_fps": 4}

    def __init__(
        self,
        desc: list[str],
        is_slippery: bool = False,
        reward_map: list[list[float]] | None = None,
        character: str = "penguin",
        max_episode_steps: int | None = None,
        render_mode: str | None = None,
        tile_size: int = 64,
    ):
        desc = validate_desc(desc)
        nrow, ncol = len(desc), len(desc[0])
        if max_episode_steps is None:
            max_episode_steps = 4 * nrow * ncol
        env = gym.make(
            "FrozenLake-v1",
            desc=desc,
            is_slippery=is_slippery,
            max_episode_steps=max_episode_steps,
            render_mode=render_mode,
        )
        super().__init__(env)
        self.desc = desc
        self.nrow, self.ncol = nrow, ncol
        self.is_slippery = is_slippery
        self.character = character if character in CHARACTERS else "penguin"
        self.tile_size = tile_size
        self._sprites: dict[str, object] = {}
        self.set_reward_map(reward_map if reward_map is not None else default_reward_grid(desc))
        self._add_walls()
        self.state: int = 0
        self.last_outcome: str | None = None

    # ------------------------------------------------------------------ helpers
    def letter(self, s: int) -> str:
        return self.desc[s // self.ncol][s % self.ncol]

    def set_reward_map(self, reward_map: list[list[float]]) -> None:
        arr = np.asarray(reward_map, dtype=float)
        if arr.shape != (self.nrow, self.ncol):
            raise ValueError(f"Reward map must have shape {(self.nrow, self.ncol)}, got {arr.shape}")
        self.reward_map = arr

    def _add_walls(self) -> None:
        """Rewrite the transition table so that moving into a wall keeps the agent in place."""
        P = self.env.unwrapped.P
        for s, per_action in P.items():
            for a, transitions in per_action.items():
                new = []
                for p, s2, r, term in transitions:
                    if self.letter(s2) == "W":
                        s2, term = s, False
                    new.append((p, s2, r, term))
                P[s][a] = new

    # --------------------------------------------------------------- gym API
    def reset(self, **kwargs):
        obs, info = self.env.reset(**kwargs)
        self.state = int(obs)
        self.last_outcome = None
        return obs, info

    def step(self, action):
        obs, _, terminated, truncated, info = self.env.step(action)
        self.state = int(obs)
        reward = float(self.reward_map.flat[self.state])
        if terminated:
            self.last_outcome = "goal" if self.letter(self.state) == "G" else "water"
        elif truncated:
            self.last_outcome = "timeout"
        info["letter"] = self.letter(self.state)
        return obs, reward, terminated, truncated, info

    # -------------------------------------------------------------- rendering
    def _sprite(self, name: str):
        from PIL import Image

        if name not in self._sprites:
            img = Image.open(ASSETS_DIR / f"{name}.png").convert("RGBA")
            self._sprites[name] = img.resize((self.tile_size, self.tile_size), Image.LANCZOS)
        return self._sprites[name]

    def render(self):
        """Return an RGB numpy array of the board drawn with the Frozen Lake game assets."""
        if self.render_mode != "rgb_array":
            raise ValueError('Create the environment with render_mode="rgb_array" to render it.')
        from PIL import Image

        t = self.tile_size
        canvas = Image.new("RGBA", (self.ncol * t, self.nrow * t), (220, 238, 250, 255))
        for r, row in enumerate(self.desc):
            for c, ch in enumerate(row):
                box = (c * t, r * t)
                canvas.alpha_composite(self._sprite("ice"), box)
                if ch == "H":
                    canvas.alpha_composite(self._sprite("water"), box)
                elif ch == "W":
                    canvas.alpha_composite(self._sprite("wall"), box)
                elif ch == "G":
                    s = r * self.ncol + c
                    if self.state == s and self.last_outcome == "goal":
                        mood = "happy"
                    elif self.last_outcome == "water":
                        mood = "angry"
                    else:
                        mood = "neutral"
                    canvas.alpha_composite(self._sprite(f"yeti-{mood}"), box)
        r, c = divmod(self.state, self.ncol)
        if self.letter(self.state) != "G":
            frozen = self.letter(self.state) == "H"
            name = f"{self.character}-frozen" if frozen else self.character
            canvas.alpha_composite(self._sprite(name), (c * t, r * t))
        return np.asarray(canvas.convert("RGB"))
