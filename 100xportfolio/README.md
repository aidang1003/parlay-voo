# 100xPortfolio

A daily stock-picking game inspired by [82-0.com](https://www.82-0.com), but for investing.

The slot machine deals you a random **5-year era** and a random **industry**. You
pick the one stock you think crushed it — five times. Then the engine simulates
your $50,000 portfolio and grades the run. Can you go **100×**?

- **5 rounds**, $10,000 invested per pick.
- Stats are **hidden** — it's a test of market history.
- **One era skip + one industry skip** for the whole game.
- The day's spins are **the same for everyone** (seeded by date).

## Stack

- **Flask** (Python) backend — daily spins + server-authoritative scoring.
- Vanilla HTML/CSS/JS frontend (no build step).
- Hand-curated historical return dataset in `app/data.py`.

## Run locally

```bash
cd 100xportfolio
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python api/index.py            # http://localhost:5000
```

## Deploy to Vercel

This folder is a self-contained Vercel project. From the Vercel dashboard, set the
**Root Directory** to `100xportfolio` and deploy — `vercel.json` wires the Flask
app (`api/index.py`) as a Python serverless function with all routes pointed at it.

```bash
# or from the CLI, inside this folder:
vercel --prod
```

## Layout

```
100xportfolio/
├── api/index.py        # Vercel entrypoint (exposes Flask `app`)
├── app/
│   ├── __init__.py     # Flask app factory + routes
│   ├── data.py         # curated (industry × era) stock dataset
│   └── game.py         # daily spins, skips, scoring & grading
├── templates/index.html
├── static/{style.css,game.js}
├── requirements.txt
└── vercel.json
```

> Educational game. Returns are hand-curated historical approximations — **not investment advice.**
