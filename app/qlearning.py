"""Tabular Q-learning with an epsilon-greedy policy."""

from __future__ import annotations

import numpy as np


class QLearningAgent:
    def __init__(
        self,
        n_states: int,
        n_actions: int = 4,
        alpha: float = 0.5,
        gamma: float = 0.95,
        epsilon: float = 0.2,
        epsilon_decay: float = 1.0,
        epsilon_min: float = 0.01,
        q_init: float = 0.0,
        seed: int | None = None,
    ):
        self.n_states, self.n_actions = n_states, n_actions
        self.alpha, self.gamma = alpha, gamma
        self.epsilon, self.epsilon_decay, self.epsilon_min = epsilon, epsilon_decay, epsilon_min
        self.q_init = q_init
        self.rng = np.random.default_rng(seed)
        self.Q = np.full((n_states, n_actions), q_init, dtype=float)

    def reset(self) -> None:
        self.Q[:] = self.q_init

    def greedy(self, s: int) -> int:
        """Greedy action with random tie-breaking (important when Q is all zeros)."""
        row = self.Q[s]
        best = np.flatnonzero(np.isclose(row, row.max()))
        return int(self.rng.choice(best))

    def act(self, s: int) -> tuple[int, bool]:
        """Return (action, explored) using epsilon-greedy."""
        if self.rng.random() < self.epsilon:
            return int(self.rng.integers(self.n_actions)), True
        return self.greedy(s), False

    def update(self, s: int, a: int, r: float, s2: int, terminated: bool) -> dict:
        """One Q-learning update. Returns the numbers involved, for display."""
        q_old = float(self.Q[s, a])
        max_next = 0.0 if terminated else float(self.Q[s2].max())
        target = r + self.gamma * max_next
        td_error = target - q_old
        self.Q[s, a] = q_old + self.alpha * td_error
        return {
            "q_old": q_old,
            "q_new": float(self.Q[s, a]),
            "max_next": max_next,
            "target": target,
            "td_error": td_error,
        }

    def end_episode(self) -> None:
        self.epsilon = max(self.epsilon_min, self.epsilon * self.epsilon_decay)
