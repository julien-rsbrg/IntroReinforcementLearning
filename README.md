# Frozen Lake: an introduction to tabular Q-learning

A small web app to teach reinforcement learning with Gymnasium's
[`FrozenLake-v1`](https://gymnasium.farama.org/environments/toy_text/frozen_lake/).
A character (penguin, elf or sea lion) has to reach the yeti without falling into the water.

- **Left:** the environment, drawn with the Frozen Lake Game Assets.
- **Right:** the Q-table. Each cell is a state split into 4 triangles, one per action (← ↓ → ↑).
  The colour shows Q(s,a), the arrow shows the greedy action, and the orange outline marks the last entry updated.
- **Below:** the last Q-learning update written out with its numbers, and the learning curve.

## What you can do on the page

| Control | Effect |
|---|---|
| **Step ▸** | the agent takes one ε-greedy action and updates one Q entry |
| **Play episode ▸▸** | plays (and learns from) a whole episode, animated |
| **Run N episodes** | trains for N episodes at full speed. Tick *animate* to watch them instead (⏸ stops after the current episode) |
| **± Rewards** | click a cell to set the reward received when **entering** it (optionally for every cell of that type) |
| **Paint** | draw ice, water, walls, the start or the yeti directly on the map |
| α, γ, ε, ε-decay | learning rate, discount factor, exploration rate, and the factor ε is multiplied by after each episode |
| Slippery ice | Gymnasium's `is_slippery`: each move goes the intended way only 1/3 of the time |

Map rules:

- **Water** ends the episode (the character freezes and the yeti gets angry).
- **Walls** can't be entered: the character bumps into them and stays where it is.
- **The yeti** ends the episode with a happy yeti.
- The reward is always the reward of the cell the agent arrives in. Bumping into a wall or the border
  gives the reward of the current cell again.
- Episodes are cut after 4 × (number of cells) steps.

Changing rewards, painting tiles or switching to another map of the same size keeps the Q-table,
so you can watch the agent adapt. Switching to a different size resets it.

### Things to try in class
1. *Classic 4×4*, default rewards: press **Step** a few times. Nothing changes until the agent stumbles onto the yeti. That's a sparse reward.
2. Then the value spreads back one cell per visit. Compare γ = 0.5 and γ = 0.99.
3. Set every ice cell to −0.05: now the agent prefers short paths and explores more, because untried actions look better than known ones.
4. Set ε = 0: the greedy agent can get stuck. Turn exploration back on.
5. *Walls 5×5* or *Shortcut 6×6*: put a +0.5 on a cell near the water and see whether the agent takes the risk.
6. Turn on slippery ice: the optimal policy changes and moves away from the water.

## Evaluation page (`/evaluate`)

Compares parameter sets (α, γ, ε, ε-decay, initial Q value, and the ice / water / yeti rewards used while learning)
on the 4 standard maps, first on normal ice and then on slippery ice:

1. a fresh agent learns for only **100 environment steps** (`TRAIN_STEPS` in `app/evaluation.py`);
2. it then plays **one greedy test run** (ε = 0, no learning). The score is the standard reward of that run:
   1 if it reaches the yeti, 0 otherwise, whatever rewards were used for learning.
3. Steps 1–2 are repeated with N seeds (default 20). The bars show the mean, with ± standard error.
   The seeds are the same for every parameter set.

Each chart shows **this run**, the **best set so far** for that ice type (highest average over the 4 maps),
and a **dotted line for a random policy**. That line is the exact probability of reaching the yeti by moving at random,
computed by dynamic programming. It's the same with and without slippery ice, which is worth explaining to students.
The history of every evaluated set is kept in the browser (`localStorage`) and can be reloaded into the form.

With only 100 steps, the larger maps are very hard. For example, optimistic initial values (Q₀ = 1, α = 1, ε = 0.1)
reach the yeti in about 65–70 % of the test runs on Classic 4×4 but almost never on the larger maps.

## Code

```
app/
  frozen_lake_yeti.py   Gymnasium wrapper: walls, per-state rewards, sprite rendering (render_mode="rgb_array")
  qlearning.py          tabular Q-learning agent (ε-greedy, random tie-breaking)
  evaluation.py         benchmark of a parameter set on the 4 standard maps + exact random baseline
  main.py               FastAPI server; one in-memory session per browser tab
  static/               the page (vanilla HTML/CSS/JS, no build step)
Frozen Lake Game Assets/png/   sprites
```

You can also use the wrapper on its own, for example in a notebook:

```python
from app.frozen_lake_yeti import FrozenLakeYeti
env = FrozenLakeYeti(["SFFF", "FHWH", "FFFH", "HFFG"], character="elf", render_mode="rgb_array",
                     reward_map=[[0, 0, 0, 0], [0, -1, 0, -1], [0, 0, 0, -1], [-1, 0, 0, 1]])
obs, info = env.reset()
obs, reward, terminated, truncated, info = env.step(2)   # 0 left, 1 down, 2 right, 3 up
frame = env.render()                                     # numpy RGB image
```

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
# open http://localhost:8000
```

## Deploy on Railway

The repo has a `Dockerfile` and a `railway.json` (Dockerfile builder, health check on `/healthz`, 1 replica).

```bash
railway login
railway init            # or `railway link` to an existing project
railway up
railway domain          # generates a public URL
```

You can also push the repo to GitHub and create a Railway service from it. Railway sets `$PORT`, and the container listens on it.

Sessions live in the server's memory (one per browser tab, removed after 6 h idle, at most 500), so
keep a **single replica and a single worker**. A redeploy clears everyone's Q-tables.
One "Run N episodes" request stops after 100 000 environment steps so the server stays responsive.
