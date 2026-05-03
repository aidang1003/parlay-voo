# Onboarding

**Status:** Implementation in progress. Branch `feat/onboarding`. Contract + deploy script + frontend page + hooks + middleware + FTUE fix + about-page reset have all landed; deploy on Anvil/Sepolia + smoke test still pending.

A guided landing page that walks a brand-new crypto user from "no wallet at all" to "ready to place a parlay on Base Sepolia." The onboarding page becomes the new root (`/`), the parlay builder moves to `/parlay`, and the existing FTUE spotlight on the builder drops its wallet-connect step plus fixes one broken step in that flow.

---

## Part 1 — Human Spec

### What this is

A new landing page at `/` that owns every prerequisite a brand-new crypto user has to clear before they can place a bet — wallet installed, connected, network switched, gas in hand, mock USDC in hand. Each prerequisite is a row in a checklist with auto-detected completion. When everything is green, the page shows an "Enter the app" CTA that takes the user to `/parlay` (the new home of the parlay builder).

The current root (`/`) is the parlay builder. This change moves the builder to `/parlay` and gives `/` to onboarding. The parlay-builder FTUE spotlight drops its first step (wallet-connect) because anyone who reaches `/parlay` from `/` already has a wallet on the right chain.

Audience: someone who has never used a crypto wallet. Assume zero familiarity with seed phrases, gas, faucets, networks, or the difference between testnet and mainnet. Each step explains *what* and *why* in one sentence and offers a single primary action.

### What it does

A landing page with a five-step checklist. Each step shows an open circle until the prerequisite is satisfied, then flips to a green check. Steps are auto-detected and idempotent — a returning user with everything in place sees five green circles and the "Enter the app" CTA, nothing else. The page never asks the user to redo a step they already passed.

**Layout.**

- **Top of page:** when all five steps are complete, an **Enter the app** button is rendered above the checklist as the first thing the user sees. While onboarding is incomplete, the top slot shows a friendly headline + a one-line testnet banner ("You're on Base Sepolia. Everything here uses fake money."), and the CTA does not appear.
- **Middle:** the five-row checklist (described below).
- **Bottom:** a quiet "Skip onboarding" link for power users who landed here by accident — sets the completion flag and routes to `/parlay`.

**Steps (top to bottom of the checklist).**

1. **Install a wallet.** Detects `window.ethereum`. If missing, the action is a download link to a recommended wallet (Rabby is the canonical recommendation since it matches the dev wallet; MetaMask + Coinbase Wallet listed as alternatives). If present, auto-checked.
2. **Connect your wallet.** ConnectKit modal. Auto-checked once `useAccount().isConnected` is true.
3. **Switch to Base Sepolia.** One-click `wallet_switchEthereumChain` (with `wallet_addEthereumChain` fallback for wallets that haven't seen the chain before). Auto-checked when `chainId === baseSepolia.id`. Subsumes the existing `ChainGuard` banner for first-time users.
4. **Get test ETH for gas.** A "Claim 0.005 ETH" button hits a one-time-per-address faucet contract that the team manually funds. Auto-checked once the connected wallet's ETH balance is ≥ 0.001 ETH (a returning user with leftover gas isn't asked to claim again). Errors are surfaced in plain English ("This wallet already claimed", "Faucet is being refilled — try again later").
5. **Get mock USDC to bet with.** A "Claim $10,000 mock USDC" button mints from `MockUSDC` via the same helper faucet, rate-limited contract-side to once per 24 hours per address. Auto-checked when the connected wallet's `MockUSDC` balance is ≥ $1,000.

**Routing.** The parlay builder moves from `/` to `/parlay`. The header's "Parlay" link, every internal link that currently points at `/`, and the "Enter the app" button all target `/parlay`. The new `/` is onboarding.

**Gating.** First-time visitors hitting any non-onboarding route are redirected to `/` once. Completion is sticky in localStorage (`onboarding:completed`) and a mirrored cookie so a Next.js middleware redirect works without waiting on hydration. Visiting `/` directly always renders the page (completed or not), so users can re-claim USDC from there.

**Faucet contract.**

A new `OnboardingFaucet.sol` lives in `packages/foundry/src/peripheral/`. Two entry points:

- `claimEth()` — sends 0.005 ETH. Reverts if the address already claimed or the contract balance is below the drip amount. One-shot per address, ever.
- `claimUsdc()` — calls `MockUSDC.mint(msg.sender, 10_000e6)`. Reverts if the address claimed within the last 24 hours.

The contract is **not** part of `Deploy.s.sol`. It has its own `script/DeployOnboardingFaucet.s.sol` that deploys it, optionally seeds it with ETH from the funding wallet, and writes its address into the broadcast JSON so `generate-deployed-contracts.ts` picks it up alongside the rest of the system. `withdrawEth(amount)` exists for emergencies.

**Funding wallet.** The faucet is funded from the wallet behind `QUOTE_SIGNER_PRIVATE_KEY`, not `DEPLOYER_PRIVATE_KEY`. Same logic that already applies to the JIT signer — refills are a routine, repeated ops task that should run from the hot key, not the cold deployer. On testnet today the two keys collapse onto the same address (the project default is `QUOTE_SIGNER_PRIVATE_KEY` falling back to `DEPLOYER_PRIVATE_KEY`), so this is a no-op there; on mainnet, where the keys are split, it keeps the deployer offline. The faucet's `owner` (set in the constructor) is the address derived from `QUOTE_SIGNER_PRIVATE_KEY` so `withdrawEth` and `setDripParams` are callable from the same key that funds it.

The frontend reads the faucet address out of `deployedContracts.ts` like any other contract. If the entry is missing for the current chain (e.g. local Anvil where the faucet wasn't deployed), the ETH and USDC steps degrade gracefully: the USDC button falls back to the existing `useMintTestUSDC` direct mint, and the ETH step shows "use anvil_setBalance via your wallet's RPC override" guidance.

**Fix to existing FTUE.**

The parlay-builder spotlight (`FTUESpotlight.tsx`) currently has a broken Phase 2 step targeting `parlay-panel` — the panel only mounts after a leg is selected, so when the spotlight activates on a fresh page the target doesn't exist and the user gets stuck. The fix:

- Drop Phase 1 step 0 (`ftue-connect-wallet`) entirely — onboarding handles wallet connect now.
- Make the `parlay-panel` step robust to a not-yet-mounted target: if the target ID isn't on the page within a 1.5s grace period, advance to the next step automatically rather than rendering nothing forever. The existing `targetExists` gate already hides the overlay; extend it to also auto-advance.

### Key design decisions

- **Onboarding owns the root path.** A brand-new user landing on a wallet/balance-aware parlay builder sees half the UI in error states (no wallet, wrong chain, zero balance) and is left to guess the order to fix them. Putting onboarding at `/` and the builder at `/parlay` means the builder can assume "you're set up" and the new user gets a single linear surface to clear before they ever see odds and buttons.
- **CTA on top once complete.** A returning user who already finished onboarding shouldn't have to scroll past five green checks to find the action. The "Enter the app" button being the first thing on the page collapses the common case into a one-click experience.
- **One-time ETH faucet, daily USDC drip.** ETH is precious testnet inventory and a one-time bound makes refilling a manageable ops task. MockUSDC is unlimited supply and the only real cost is a tx fee, so a daily drip lets returning users top up without redeploying anything.
- **Helper contract excluded from main deploy.** The faucet is operationally distinct from the protocol — it can be redeployed, drained, refilled, paused independently. Keeping it out of `Deploy.s.sol` means a re-deploy of the protocol doesn't reset the faucet's `claimed` map and doesn't risk forgetting to fund it.
- **Funded from the JIT signer key, not the deployer.** Refilling the faucet is a routine task that wants a hot key. The deployer key is intended to be cold on mainnet. `QUOTE_SIGNER_PRIVATE_KEY` is already the project's "always-online" signer; reusing it for faucet ops avoids introducing a third operational key. On testnet the two keys collapse onto the same address by default, so nothing changes day-to-day; on mainnet the split is meaningful.
- **Auto-detect, never re-ask.** Each step has a passive completion check, not just a "did the user click the button" flag. A returning user with funds shouldn't see the faucet buttons at all.
- **Wallet-agnostic copy.** The brain-dump named MetaMask; the dev wallet is Rabby. Onboarding recommends one wallet but treats all `window.ethereum` providers equally — copy says "your wallet" once a wallet is connected, not "MetaMask."
- **Network-add fallback.** A pure `wallet_switchEthereumChain` call fails silently in some wallet versions if the chain isn't already added. The button issues `wallet_addEthereumChain` first (idempotent) then `wallet_switchEthereumChain`.

### What the user sees

**First-time visitor** lands on `/`. Five rows, each with a label, a one-line "what this means," an open circle on the left, and an action button on the right. A testnet banner sits at the top. They work down the list — the next incomplete row's button gets visual emphasis, so there is always exactly one obvious action.

As they complete steps, circles flip to green checks and the buttons collapse into a quiet "Done" pill. When the last step turns green, the **Enter the app** CTA appears at the top of the page.

**Returning user** lands on `/`. All five rows show green checks; the **Enter the app** button is already at the top. One click → `/parlay`, where the parlay-builder FTUE picks up at "Build Your Parlay" (the wallet step has been removed from the spotlight).

**Header navigation:** the "Parlay" link now points at `/parlay`. The logo still links to `/`. A user who clicks the logo from inside the app returns to onboarding (which, if completed, is just the CTA on top — one click back into the builder).

---

## Part 2 — AI Spec Sheet

*Terse implementation reference. Change docs keep their AI spec inline.*

### Open questions

| # | Question | Default if not answered |
|---|---|---|
| Q1 | Canonical recommended wallet for step 1? | Rabby (matches dev wallet). MetaMask + Coinbase Wallet listed as alternatives. |
| Q2 | ETH balance threshold to consider step 4 "complete"? | ≥ 0.001 ETH. |
| Q3 | USDC balance threshold to consider step 5 "complete"? | ≥ 1,000 mock USDC. |
| Q4 | USDC drip cooldown? | 24h, contract-enforced via `lastUsdcClaim[address]`. |
| Q5 | Faucet ownership of MockUSDC? | None needed. `MockUSDC.mint` is already public; faucet calls it directly. |
| Q6 | Behavior when faucet runs out of ETH mid-onboarding? | Step 4 shows "Faucet refilling — ping the team." Step 5 still works. "Enter the app" still works (step 4 is not blocking once steps 1–3 are green and step 5 is irrelevant — actually step 4 is also not blocking; only steps 1–3 block the CTA). |
| Q7 | Should `/parlay` and `/` both be reachable from the header, or is `/` only via logo? | Logo only. Header nav still has "Parlay" pointing at `/parlay`. No "Onboarding" header link. |
| Q8 | Reset onboarding affordance? | "Reset onboarding" button on `/about` clears `onboarding:completed` localStorage + cookie and clears the FTUE storage keys. |
| Q9 | Faucet funding + owner key? | `QUOTE_SIGNER_PRIVATE_KEY`. `DeployOnboardingFaucet.s.sol` broadcasts as that key, sets `owner = vm.addr(QUOTE_SIGNER_PRIVATE_KEY)`, and seeds initial ETH from the same wallet. Falls back to `DEPLOYER_PRIVATE_KEY` when unset (mirrors the existing project default). |

### File operations

**Create**
```
packages/foundry/src/peripheral/OnboardingFaucet.sol
packages/foundry/test/unit/OnboardingFaucet.t.sol
packages/foundry/script/DeployOnboardingFaucet.s.sol
packages/nextjs/src/app/parlay/page.tsx                  (moved from src/app/page.tsx)
packages/nextjs/src/app/parlay/<co-located children>     (any siblings of the old root page move with it)
packages/nextjs/src/app/page.tsx                         (NEW: onboarding landing — replaces the old root)
packages/nextjs/src/app/_onboard/EnterAppCTA.tsx
packages/nextjs/src/app/_onboard/OnboardStep.tsx
packages/nextjs/src/app/_onboard/InstallWalletStep.tsx
packages/nextjs/src/app/_onboard/ConnectWalletStep.tsx
packages/nextjs/src/app/_onboard/SwitchNetworkStep.tsx
packages/nextjs/src/app/_onboard/ClaimEthStep.tsx
packages/nextjs/src/app/_onboard/ClaimUsdcStep.tsx
packages/nextjs/src/lib/hooks/onboarding.ts              useOnboardingFaucet, useOnboardingProgress
packages/nextjs/src/lib/onboarding.ts                    localStorage + cookie helpers
packages/nextjs/src/middleware.ts                        first-visit redirect → "/"
```

**Move**
```
packages/nextjs/src/app/page.tsx → packages/nextjs/src/app/parlay/page.tsx
  (and any co-located client components / loading.tsx / etc. that belong to the parlay builder)
```

**Edit in place**
```
packages/nextjs/src/components/Header.tsx
  • NAV_LINKS: { href: "/", label: "Parlay" } → { href: "/parlay", label: "Parlay" }
  • Logo Link href stays "/" (now goes to onboarding; if completed, CTA is on top)
packages/nextjs/src/components/FTUESpotlight.tsx
  • PHASE_1_STEPS: drop the "ftue-connect-wallet" entry. New phase-1 starts at "Build Your Parlay".
  • useFTUEInternal: extend the targetExists path to auto-advance after a 1500ms grace window when the target ID never appears.
packages/nextjs/src/app/about/page.tsx
  • add a "Reset onboarding" button (clears onboarding:completed flag + FTUE storage keys + cookie)
packages/nextjs/src/lib/hooks/index.ts
  • re-export from "./onboarding"
package.json (root)
  • add "deploy:faucet:local" / "deploy:faucet:sepolia" scripts wrapping forge script DeployOnboardingFaucet
  • scripts pass --private-key $QUOTE_SIGNER_PRIVATE_KEY (with shell-level fallback to $DEPLOYER_PRIVATE_KEY when unset, mirroring HelperConfig logic)
docs/RUNBOOK.md
  • add "Refill the onboarding faucet" section: balance check, refill via `cast send <faucet> --value 0.1ether --private-key $QUOTE_SIGNER_PRIVATE_KEY`, and a note that the same key owns the contract (so `withdrawEth` / `setDripParams` are callable from it).
docs/DEPLOYMENT.md
  • document the separate faucet deploy step + its funding wallet (QUOTE_SIGNER_PRIVATE_KEY)
.env (root)
  • no new keys required; both QUOTE_SIGNER_PRIVATE_KEY and DEPLOYER_PRIVATE_KEY already documented
docs/ARCHITECTURE.md
  • update the route inventory: "/" is onboarding, "/parlay" is the builder
packages/nextjs/CLAUDE.md
  • update "Pages" list: "/" onboarding, "/parlay" parlay builder
CLAUDE.md (root)
  • update key-files frontend block: "app/parlay/page.tsx -- parlay builder" + "app/page.tsx -- onboarding landing"
```

**Internal-link audit (search + fix to point at `/parlay` instead of `/`)**
```
grep for: href="/"  Link to "/"  router.push("/")  redirect("/")
  in: packages/nextjs/src/**/*.{ts,tsx}
distinguish: "go home/landing" (keep "/") vs "go to the builder" (rewrite to "/parlay")
known callers to verify (non-exhaustive):
  components/Header.tsx                   NAV_LINKS first entry → /parlay
  any "Back to builder" / "Place a bet" CTA from /vault, /tickets, /ticket/[id], /agents, /about
```

### Contract: OnboardingFaucet.sol

```solidity
contract OnboardingFaucet is Ownable {
  IMockUSDC public immutable usdc;
  uint256 public ethDripAmount;       // default 0.005 ether, settable by owner
  uint256 public usdcDripAmount;      // default 10_000e6
  uint256 public usdcCooldown;        // default 24 hours

  mapping(address => bool)    public ethClaimed;
  mapping(address => uint256) public lastUsdcClaim;

  event EthClaimed(address indexed user, uint256 amount);
  event UsdcClaimed(address indexed user, uint256 amount);

  error AlreadyClaimedEth();
  error UsdcCooldownActive(uint256 nextClaimAt);
  error FaucetEmpty();

  // owner_ is the QUOTE_SIGNER address — same key that funds + refills.
  constructor(address usdc_, address owner_) Ownable(owner_) { ... }

  function claimEth() external;       // permissionless, one-shot per address
  function claimUsdc() external;      // permissionless, 24h cooldown
  function fund() external payable;   // anyone can refill ETH
  function withdrawEth(uint256 amount) external onlyOwner;
  function setDripParams(uint256 ethAmt, uint256 usdcAmt, uint256 cooldown) external onlyOwner;

  receive() external payable;
}
```

**Invariants.**

- `claimEth()` reverts on second call from the same `msg.sender`.
- `claimUsdc()` reverts if `block.timestamp < lastUsdcClaim[msg.sender] + usdcCooldown`.
- The faucet never holds USDC — it mints directly to `msg.sender` via `MockUSDC.mint`.
- `withdrawEth` is the only owner-only fund-touching path.
- `owner == vm.addr(QUOTE_SIGNER_PRIVATE_KEY)` after deploy, so the same key that funds the faucet can also withdraw and reconfigure it.

**Deploy script (`DeployOnboardingFaucet.s.sol`).**

```solidity
function run() external {
  uint256 pk = vm.envOr("QUOTE_SIGNER_PRIVATE_KEY", vm.envUint("DEPLOYER_PRIVATE_KEY"));
  address owner = vm.addr(pk);
  address usdc  = _readMockUsdcFromBroadcast();   // same lookup pattern as FundWallet.s.sol

  vm.startBroadcast(pk);
    OnboardingFaucet faucet = new OnboardingFaucet(usdc, owner);
    faucet.fund{value: INITIAL_ETH_SEED}();        // optional; skip if seed amount is 0
  vm.stopBroadcast();
}
```

Initial seed amount is a script constant (default 0.1 ether on Sepolia, 0 on local). The script reads `MockUSDC` from the latest broadcast JSON rather than env, matching `FundWallet.s.sol`.

**Tests required.**

- `claimEth_succeedsOnFirstCall` / `claimEth_revertsOnSecondCall`
- `claimEth_revertsWhenContractEmpty`
- `claimUsdc_succeedsAfterCooldown` / `claimUsdc_revertsDuringCooldown`
- `setDripParams_onlyOwner`
- `withdrawEth_onlyOwner` / `withdrawEth_partial`
- Fuzz: many addresses claim ETH; total transferred matches `claimedCount * ethDripAmount`.

### Frontend: routing + redirect

```
middleware.ts
  matcher: ["/((?!api|_next|favicon|$).*)"]    // all routes except API, statics, and the root itself
  if (req.cookies.onboarding_completed !== "true") return NextResponse.redirect(new URL("/", req.url))
```

`onboarding_completed` cookie is set by the new `/` page when the user clicks "Enter the app" (mirrors localStorage so SSR redirect logic works without hydration). The `/about` reset button clears both.

### Frontend: hooks

```
useOnboardingProgress():
  {
    walletInstalled: boolean,         // window.ethereum?
    walletConnected: boolean,         // useAccount().isConnected
    onCorrectChain: boolean,          // chainId === baseSepolia.id
    hasGas: boolean,                  // ETH balance >= 0.001 ETH
    hasUsdc: boolean,                 // MockUSDC balance >= 1_000e6
    completed: boolean,               // all five true
    canEnter: boolean,                // walletInstalled && walletConnected && onCorrectChain
                                      // (CTA disabled until the wallet is usable, but funds aren't strictly required)
  }

useOnboardingFaucet():
  {
    claimEth: () => Promise<void>,    // wraps useWriteContract → claimEth()
    claimUsdc: () => Promise<void>,   // wraps useWriteContract → claimUsdc()
    canClaimEth: boolean,             // !ethClaimed[address]
    canClaimUsdc: boolean,            // block.timestamp >= lastUsdcClaim[address] + cooldown
    nextUsdcClaimAt: number | null,   // unix seconds
    isPending, isConfirming, isSuccess, error  // standard pattern (see lib/hooks/_internal.ts)
  }
```

### Call graph

```
visit any non-/ route as first-time user
  → middleware.ts
    → !cookie: redirect "/"

/ ("Claim ETH")
  → useOnboardingFaucet.claimEth()
    → writeContract(OnboardingFaucet.claimEth)
      → faucet.transfer(msg.sender, 0.005 ether)

/ ("Claim USDC")
  → useOnboardingFaucet.claimUsdc()
    → writeContract(OnboardingFaucet.claimUsdc)
      → MockUSDC.mint(msg.sender, 10_000e6)

/ ("Enter the app")
  → setOnboardingCompleted()  → localStorage + cookie
  → router.push("/parlay")
    → FTUESpotlight Phase 1 starts at "Build Your Parlay" (wallet step removed)

header logo click
  → router.push("/")
    → if completed: page renders CTA on top, five green checks below
    → else: page renders banner + checklist (no CTA on top)
```

### Invariants preserved

1. `pnpm gate` passes after the change.
2. `Deploy.s.sol` does not deploy `OnboardingFaucet`. The protocol can be redeployed without affecting faucet state.
3. `Engine never holds USDC` — the faucet mints directly to user; HouseVault and ParlayEngine are untouched.
4. No change to on-chain protocol addresses.
5. `MockUSDC.mint` remains public (the existing `useMintTestUSDC` hook keeps working as a fallback when the faucet contract is not deployed for the current chain).
6. The parlay builder source is moved verbatim from `app/page.tsx` to `app/parlay/page.tsx` — no behavior changes during the move; behavior changes (FTUE step removal, `parlay-panel` auto-advance) ride on top in the same PR.

### Change log

Bullets added as work lands. One bullet per concrete change, file paths included.

- `docs/changes/ONBORADING.md` renamed to `docs/changes/ONBOARDING.md`; brain-dump rewritten as Part 1 + Part 2 spec; root path now reserved for onboarding, parlay builder slated to move to `/parlay`.
- Plan updated: faucet is funded + owned by the wallet behind `QUOTE_SIGNER_PRIVATE_KEY` (falling back to `DEPLOYER_PRIVATE_KEY` when unset, mirroring HelperConfig). `DeployOnboardingFaucet.s.sol` broadcasts as that key, sets `owner = vm.addr(QUOTE_SIGNER_PRIVATE_KEY)`, and seeds initial ETH from the same wallet. Runbook + deployment doc updates added to file-ops list.

**Implementation — landed**

- Created `packages/foundry/src/peripheral/OnboardingFaucet.sol` (Ownable, immutable USDC ref, `claimEth` one-shot per address, `claimUsdc` 24h cooldown, `fund` permissionless, `withdrawEth` + `setDripParams` owner-only). Custom errors: `AlreadyClaimedEth`, `UsdcCooldownActive(nextClaimAt)`, `FaucetEmpty`, `EthTransferFailed`.
- Created `packages/foundry/test/unit/OnboardingFaucet.t.sol` — 16 tests, all passing. Covers first/second-claim, contract-empty revert, separate-address claims, cooldown, owner-only setters, fuzz on total ETH transferred.
- Created `packages/foundry/script/DeployOnboardingFaucet.s.sol` — broadcasts as `QUOTE_SIGNER_PRIVATE_KEY` (falls back through the same chain HelperConfig uses), reads MockUSDC from latest broadcast JSON, owner = signer address, seeds 0.1 ETH on Sepolia / 0 on Anvil.
- Extended `scripts/generate-deployed-contracts.ts` to discover both `Deploy.s.sol` and `DeployOnboardingFaucet.s.sol` broadcast directories and merge per-chain entries; `OnboardingFaucet` added to `CONTRACT_NAMES`. Added `deploy:faucet:local` / `deploy:faucet:sepolia` scripts in root `package.json`. JSON output now sorted alphabetically for determinism across merge orders.
- Moved `packages/nextjs/src/app/page.tsx` → `app/parlay/page.tsx` (`git mv`). Header NAV_LINK rewired to `/parlay` (logo stays at `/`). Internal "Start Building" / "Build Your First Parlay" / "Try a lossless parlay" / "Place a Lossless Parlay" CTAs across `about`, `tickets`, `RehabLocks`, `RehabCTA` updated to `/parlay`.
- Created onboarding landing at `app/page.tsx` — five-step checklist, top-of-page "Enter the app" CTA when complete, hero + testnet banner when not, "Skip onboarding" link at the bottom.
- Created step components in `app/_onboard/`: `OnboardStep` (shared row with circle + title + action), `InstallWalletStep` (Rabby canonical, MetaMask + Coinbase Wallet alternates), `ConnectWalletStep` (ConnectKit modal trigger), `SwitchNetworkStep` (uses `useSwitchChain`), `ClaimEthStep`, `ClaimUsdcStep`, `EnterAppCTA` (sets cookie + localStorage, routes to `/parlay`).
- Created `lib/onboarding.ts` (localStorage `onboarding:completed` + cookie helpers `getCompleted`, `setCompleted`, `resetOnboarding`).
- Created `lib/hooks/onboarding.ts` (`useOnboardingProgress` returns flags + `hydrated`; `useOnboardingFaucet` wraps `claimEth`/`claimUsdc` with `usePinnedWriteContract`, surfaces cooldown state + decoded errors). Local `useFaucetContract()` does runtime lookup so the file typechecks before the faucet is in `deployedContracts.ts`. Re-exported from `lib/hooks/index.ts`.
- Created `packages/nextjs/src/middleware.ts` — redirects to `/` when `onboarding_completed` cookie is missing on any route except `/`, `/api`, `/_next/*`, statics.
- Edited `components/FTUESpotlight.tsx`: dropped `ftue-connect-wallet` from `PHASE_1_STEPS` (now starts at "Build Your Parlay"); extended the measure loop with a 1500ms grace + auto-advance when the target ID never appears (fixes the `parlay-panel` blank-overlay bug). FTUE tests updated for the smaller phase 1 (3→2 progress dots, "Build Your Parlay" instead of "Connect Your Wallet").
- Created `app/about/ResetOnboardingButton.tsx` (client component) and wired it under the bottom CTA on `/about`. Calls `resetOnboarding()` then routes to `/`.
- Updated docs: `CLAUDE.md` (root) frontend block + Foundry block now reference `app/parlay/`, `app/_onboard/`, `middleware.ts`, `lib/onboarding.ts`, `lib/hooks/onboarding.ts`, `OnboardingFaucet.sol`, `DeployOnboardingFaucet.s.sol`. `packages/nextjs/CLAUDE.md` Pages list updated. `docs/RUNBOOK.md` gains an "Onboarding Faucet" section (deploy, balance check, refill, owner-only ops). `docs/DEPLOYMENT.md` gains an "Onboarding faucet (separate deploy)" section. `docs/ARCHITECTURE.md` Mermaid diagram: frontend node now reads "Onboarding (/) → Parlay (/parlay) / Vault / Tickets / Ticket Detail / About"; contracts subgraph adds an `OnboardingFaucet` node marked "(separate deploy)".

**Pending**

- `pnpm deploy:faucet:local` + manual smoke test on Anvil (fresh wallet, all five steps green, /parlay loads, FTUE skips wallet step).
- `pnpm deploy:faucet:sepolia` + on-chain verification of the funded faucet.
- `pnpm gate` (test + typecheck + build) green from a clean tree.
