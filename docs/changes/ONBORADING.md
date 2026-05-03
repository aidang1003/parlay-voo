Parlay Voo + Base Sepolia testnet onboarding
0) Verify that Metamask is installed  > direct users to install if not
1) Add the Sepolia base testnet to your wallet
2) change networks
3) implement a faucet that sends .005 testnet eth to a wallet one time. Do not allow the same wallet address to collect more than once. Implement in a static helper contract that I will manually fund. ensure this contract does not get deployed with the main deploy script. Track the helper contract address and ABI though so the frontend can easily interact with it.
4) Drip $10000 mock usdc daily
5) direct the user to the parlays page when all tasks are complete
Each step along the way should indicate completion with a circle that goes green. When the task isn't complete just have an open circle. this should be the landing page. At the bottom include an option to Enter the app which takes users to the parlay builder screen. I would like to see checks for each of these items. If the user alread has one complete just mark the circle as complete so they move on to the next item.

This should replace the first step of our ticket page onboarding popups since that is chekcing for the wallet. While we're making this upgrade fix the popups so the one demonstrating the cert (the fourth step currently) actually has a popup where a user can complete the sequence. Notived this bug on testing.

