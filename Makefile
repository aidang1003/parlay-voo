# ParlayCity Development Makefile

PID_DIR := .pids

-include .env
export

# ── Setup ────────────────────────────────────────────────────────────────────

bootstrap:
	./scripts/bootstrap.sh

setup:
	pnpm install
	cd packages/foundry && forge install foundry-rs/forge-std --no-git 2>/dev/null || true
	cd packages/foundry && forge install OpenZeppelin/openzeppelin-contracts --no-git 2>/dev/null || true

# ── Local Development ────────────────────────────────────────────────────────

chain:
	cd packages/foundry && anvil

deploy-local:
	cd packages/foundry && env -u USDC_ADDRESS forge script script/Deploy.s.sol --broadcast --rpc-url http://127.0.0.1:8545
	env -u USDC_ADDRESS ./scripts/sync-env.sh

dev:
	@echo "Starting ParlayVoo dev stack..."
	@mkdir -p $(PID_DIR)
	@for port in 3000 8545; do lsof -ti :$$port | xargs kill -9 2>/dev/null || true; done
	@sleep 1
	@nohup anvil > $(PID_DIR)/anvil.log 2>&1 & echo $$! > $(PID_DIR)/anvil.pid
	@echo "  Anvil started (pid $$(cat $(PID_DIR)/anvil.pid)) on :8545"
	@sleep 2
	@cd packages/foundry && forge clean > /dev/null 2>&1 || true
	@cd packages/foundry && env -u USDC_ADDRESS forge script script/Deploy.s.sol --broadcast --rpc-url http://127.0.0.1:8545 > ../../$(PID_DIR)/deploy.log 2>&1
	@env -u USDC_ADDRESS ./scripts/sync-env.sh
	@echo "  Contracts deployed, .env.local synced"
#	@npx tsx scripts/register-legs.ts > $(PID_DIR)/register-legs.log 2>&1 || echo "  (register-legs skipped)"
#	@echo "  Catalog legs registered"
	@cd packages/nextjs && nohup pnpm dev > ../../$(PID_DIR)/web.log 2>&1 & echo $$! > $(PID_DIR)/web.pid
	@echo "  Web started (pid $$(cat $(PID_DIR)/web.pid)) on :3000"
	@sleep 3
	@echo ""
	@echo "Dev stack running. Use 'make dev-stop' to shut down."
	@echo "  Anvil: http://localhost:8545"
	@echo "  Web:   http://localhost:3000"
	@echo "Logs in $(PID_DIR)/*.log"

dev-stop:
	@echo "Stopping dev stack..."
	@for pidfile in $(PID_DIR)/*.pid; do \
		if [ -f "$$pidfile" ]; then \
			pid=$$(cat "$$pidfile"); \
			kill $$pid 2>/dev/null && echo "  Stopped pid $$pid ($$(basename $$pidfile .pid))" || true; \
			rm -f "$$pidfile"; \
		fi; \
	done
	@for port in 3000 8545; do lsof -ti :$$port | xargs kill -9 2>/dev/null || true; done
	@echo "All services stopped."

dev-status:
	@echo "ParlayCity dev services:"
	@for port in 8545 3000; do \
		if [ "$$port" = "8545" ]; then name="Anvil"; else name="Web"; fi; \
		pid=$$(lsof -ti :$$port 2>/dev/null | head -1); \
		if [ -n "$$pid" ]; then echo "  $$name (:$$port) - running (pid $$pid)"; \
		else echo "  $$name (:$$port) - stopped"; fi; \
	done

# ── Testing ──────────────────────────────────────────────────────────────────

test-contracts:
	cd packages/foundry && forge test -vvv

test-web:
	cd packages/nextjs && pnpm test

test-all: test-contracts test-web

test-e2e:
	cd packages/e2e && pnpm test

# ── Quality Gate ─────────────────────────────────────────────────────────────

gate: test-all typecheck build

typecheck:
	cd packages/nextjs && npx tsc --noEmit

build:
	cd packages/nextjs && pnpm build

build-contracts:
	cd packages/foundry && forge build

coverage:
	cd packages/foundry && forge coverage --report summary

snapshot:
	cd packages/foundry && forge snapshot

# ── Sepolia Deployment ───────────────────────────────────────────────────────

deploy-sepolia:
	@test -n "$$DEPLOYER_PRIVATE_KEY" || (echo "Error: DEPLOYER_PRIVATE_KEY required" && exit 1)
	$(eval RPC := $(or $(BASE_SEPOLIA_RPC_URL),https://sepolia.base.org))
	$(eval VERIFY_FLAG := $(if $(BASESCAN_API_KEY),--verify --etherscan-api-key $(BASESCAN_API_KEY) --verifier-url https://api-sepolia.basescan.org/api,))
	cd packages/foundry && \
		PRIVATE_KEY=$$DEPLOYER_PRIVATE_KEY \
		$(if $(USDC_ADDRESS),USDC_ADDRESS=$(USDC_ADDRESS)) \
		BOOTSTRAP_DAYS=30 \
		forge script script/Deploy.s.sol \
			--broadcast --rpc-url $(RPC) $(VERIFY_FLAG) --slow
	$(if $(USDC_ADDRESS),USDC_ADDRESS=$(USDC_ADDRESS)) ./scripts/sync-env.sh sepolia

deploy-sepolia-full: deploy-sepolia register-legs-sepolia demo-seed-sepolia

register-legs:
	npx tsx scripts/register-legs.ts

register-legs-sepolia:
	$(eval RPC := $(or $(BASE_SEPOLIA_RPC_URL),https://sepolia.base.org))
	RPC_URL=$(RPC) PRIVATE_KEY=$$DEPLOYER_PRIVATE_KEY npx tsx scripts/register-legs.ts

demo-seed-sepolia:
	USDC_ADDRESS=$(USDC_ADDRESS) \
	BASE_SEPOLIA_RPC_URL=$(or $(BASE_SEPOLIA_RPC_URL),https://sepolia.base.org) \
	DEPLOYER_PRIVATE_KEY=$$DEPLOYER_PRIVATE_KEY \
	ACCOUNT1_PRIVATE_KEY=$${ACCOUNT1_PRIVATE_KEY:-$$DEPLOYER_PRIVATE_KEY} \
		./scripts/demo-seed.sh sepolia

create-pool-sepolia:
	@test -n "$$DEPLOYER_PRIVATE_KEY" || (echo "Error: DEPLOYER_PRIVATE_KEY required" && exit 1)
	$(eval RPC := $(or $(BASE_SEPOLIA_RPC_URL),https://sepolia.base.org))
	cd packages/foundry && \
		PRIVATE_KEY=$$DEPLOYER_PRIVATE_KEY \
		USDC_ADDRESS=$(USDC_ADDRESS) \
		WETH_ADDRESS=$(or $(WETH_ADDRESS),0x4200000000000000000000000000000000000006) \
		UNISWAP_NFPM=$(or $(UNISWAP_NFPM),0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2) \
		forge script script/CreatePool.s.sol \
			--broadcast --rpc-url $(RPC) --slow

fund-deployer:
	@echo "Deployer: $(or $(DEPLOYER_ADDRESS),$(shell cast wallet address $$DEPLOYER_PRIVATE_KEY 2>/dev/null || echo 'not set'))"
	@echo "ETH faucet: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet"
	@echo "USDC faucet: https://faucet.circle.com/"

fund-wallet:
	$(eval RPC := $(or $(BASE_SEPOLIA_RPC_URL),https://sepolia.base.org))
	$(eval USDC := $(shell grep NEXT_PUBLIC_USDC_ADDRESS packages/nextjs/.env.local 2>/dev/null | cut -d= -f2))
	$(eval AMT_RAW := $(shell echo "$(or $(AMOUNT),10000) * 1000000" | bc))
	@test -n "$(WALLET)" || (echo "Usage: make fund-wallet WALLET=0x..." && exit 1)
	@test -n "$(USDC)" || (echo "Error: USDC not found. Run deploy first." && exit 1)
	cast send $(USDC) "mint(address,uint256)" $(WALLET) $(AMT_RAW) \
		--rpc-url $(RPC) --private-key $(DEPLOYER_PRIVATE_KEY)

sync-env:
	./scripts/sync-env.sh

# ── Agents ───────────────────────────────────────────────────────────────────

risk-agent:
	npx tsx scripts/risk-agent.ts

risk-agent-dry:
	DRY_RUN=true npx tsx scripts/risk-agent.ts

settler-sepolia:
	$(eval RPC := $(or $(BASE_SEPOLIA_RPC_URL),https://sepolia.base.org))
	RPC_URL=$(RPC) PRIVATE_KEY=$$DEPLOYER_PRIVATE_KEY npx tsx scripts/settler-bot.ts

risk-agent-sepolia:
	$(eval RPC := $(or $(BASE_SEPOLIA_RPC_URL),https://sepolia.base.org))
	RPC_URL=$(RPC) PRIVATE_KEY=$$DEPLOYER_PRIVATE_KEY DRY_RUN=false npx tsx scripts/risk-agent.ts

demo-seed:
	./scripts/demo-seed.sh

demo-autopilot:
	npx tsx scripts/demo-autopilot.ts

# ── Cleanup ──────────────────────────────────────────────────────────────────

clean:
	cd packages/foundry && forge clean
	cd packages/nextjs && rm -rf .next

.PHONY: bootstrap setup chain deploy-local dev dev-stop dev-status test-contracts test-web test-all test-e2e gate typecheck build build-contracts coverage snapshot deploy-sepolia deploy-sepolia-full register-legs register-legs-sepolia demo-seed-sepolia create-pool-sepolia fund-deployer fund-wallet sync-env risk-agent risk-agent-dry settler-sepolia risk-agent-sepolia demo-seed demo-autopilot clean
