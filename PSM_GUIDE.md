# PSM guide

# Spark PSM3 Deployments

Spark's PSM3 (`PSM3.sol`) is the L2 three-asset peg stability module that lets
users swap between USDC, USDS, and sUSDS at fixed/oracle rates. It extends
Sky's mainnet PSM liquidity onto L2s. Mainnet itself does **not** run PSM3 —
it uses the Sky/Maker Lite PSM (`USDS_LITE_PSM = 0xf6e72Db5454dd049d0788e411b06CfAF16853042`).

## Addresses by chain

| Chain                 | Chain ID | PSM3 Address                                 | Explorer                                                                                                   |
| --------------------- | -------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Base                  | 8453     | `0x1601843c5E9bC251A3272907010AFa41Fa18347E` | [BaseScan](https://basescan.org/address/0x1601843c5E9bC251A3272907010AFa41Fa18347E)                        |
| Arbitrum One          | 42161    | `0x2B05F8e1cACC6974fD79A673a341Fe1f58d27266` | [Arbiscan](https://arbiscan.io/address/0x2B05F8e1cACC6974fD79A673a341Fe1f58d27266)                         |
| Optimism (OP Mainnet) | 10       | `0xe0F9978b907853F354d79188A3dEfbD41978af62` | [Optimistic Etherscan](https://optimistic.etherscan.io/address/0xe0F9978b907853F354d79188A3dEfbD41978af62) |
| Unichain              | 130      | `0x7b42Ed932f26509465F7cE3FAF76FfCe1275312f` | [Uniscan](https://uniscan.xyz/address/0x7b42Ed932f26509465F7cE3FAF76FfCe1275312f)                          |

## Token addresses

All values pulled from the same `spark-address-registry` chain files. USDC is
native Circle USDC on every chain (not bridged USDC.e). USDS and sUSDS are the
Sky-deployed canonical L2 versions.

| Chain        | USDC (6 dec)                                 | sUSDS (18 dec)                               | USDS (18 dec)                                |
| ------------ | -------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| Base         | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0x5875eEE11Cf8398102FdAd704C9E96607675467a` | `0x820C137fa70C8691f0e44Dc420a5e53c168921Dc` |
| Arbitrum One | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | `0xdDb46999F8891663a8F2828d25298f70416d7610` | `0x6491c05A82219b8D1479057361ff1654749b876b` |
| Optimism     | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | `0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0` | `0x4F13a96EC5C4Cf34e442b46Bbd98a0791F20edC3` |
| Unichain     | `0x078D782b760474a361dDA0AF3839290b0EF57AD6` | `0xA06b10Db9F390990364A3984C04FaDf1c13691b5` | `0x7E10036Acc4B56d4dFCa3b77810356CE52313F9C` |

## Swap guide: USDC ⇄ sUSDS via PSM3

PSM3 exposes two swap functions. Both atomically pull `assetIn` from `msg.sender`
(via `transferFrom`, so an ERC-20 `approve` to PSM3 is required first) and push
`assetOut` to `receiver`.

### Function signatures

```solidity
function swapExactIn(
    address assetIn,
    address assetOut,
    uint256 amountIn,
    uint256 minAmountOut,
    address receiver,
    uint256 referralCode
) external returns (uint256 amountOut);

function swapExactOut(
    address assetIn,
    address assetOut,
    uint256 amountOut,
    uint256 maxAmountIn,
    address receiver,
    uint256 referralCode
) external returns (uint256 amountIn);
```

And the matching view helpers (no state, no approval needed):

```solidity
function previewSwapExactIn(address assetIn, address assetOut, uint256 amountIn)
    external view returns (uint256 amountOut);

function previewSwapExactOut(address assetIn, address assetOut, uint256 amountOut)
    external view returns (uint256 amountIn);
```

### Parameter notes

- **`assetIn` / `assetOut`** — must each be one of `usdc()`, `usds()`, or
  `susds()` on that PSM3. Any other token reverts. Amounts are in the
  _asset's own_ native decimals: USDC is 6, USDS and sUSDS are 18.
- **`amountIn` / `amountOut`** — exact input or exact output, depending on
  which function you call.
- **`minAmountOut`** (exact-in) — slippage floor. Because the sUSDS↔USD rate
  ticks up every block from the SSR, set this from `previewSwapExactIn` minus
  a small tolerance, or trust the rate provider and pass `0` only if you
  fully trust the call to revert on insufficient liquidity. Use a sane bound
  in production.
- **`maxAmountIn`** (exact-out) — slippage ceiling, same logic in reverse.
- **`receiver`** — where `assetOut` is sent. Can be any address, useful for
  routing into a vault or another contract in the same tx.
- **`referralCode`** — opaque `uint256` emitted in the `Swap` event for
  off-chain attribution. Pass `0` if unused.
- **Reverts** when (a) PSM3's balance of `assetOut` is insufficient,
  (b) the realized output is below `minAmountOut`, or (c) either asset is
  unsupported.

### USDC → sUSDS (deposit into yield)

```solidity
IERC20(USDC).approve(address(PSM3), amountInUsdc);                  // amountInUsdc has 6 decimals

uint256 quote = PSM3.previewSwapExactIn(USDC, SUSDS, amountInUsdc); // sUSDS, 18 decimals
uint256 minOut = quote * 9995 / 10000;                              // e.g. 5 bps tolerance

uint256 sUsdsReceived = PSM3.swapExactIn({
    assetIn:      USDC,
    assetOut:     SUSDS,
    amountIn:     amountInUsdc,
    minAmountOut: minOut,
    receiver:     msg.sender,
    referralCode: 0
});
```

Internally PSM3 prices this as USDC → USD (1:1) → sUSDS (via the rate
provider's current sUSDS/USD rate, 1e27 precision). You receive
approximately `amountInUsdc * 1e12 / sUsdsRate` sUSDS shares.

### sUSDS → USDC (exit yield)

```solidity
IERC20(SUSDS).approve(address(PSM3), amountInSusds);                // 18 decimals

uint256 quote = PSM3.previewSwapExactIn(SUSDS, USDC, amountInSusds);// USDC, 6 decimals
uint256 minOut = quote * 9995 / 10000;

uint256 usdcReceived = PSM3.swapExactIn({
    assetIn:      SUSDS,
    assetOut:     USDC,
    amountIn:     amountInSusds,
    minAmountOut: minOut,
    receiver:     msg.sender,
    referralCode: 0
});
```

This direction is liquidity-constrained by USDC sitting in PSM3's `pocket`
(currently the PSM3 contract itself on every chain). If the pocket can't
cover the requested USDC, the call reverts — front-runners draining USDC is
the main reason to use private RPCs or to size against the live balance you
read from `IERC20(USDC).balanceOf(PSM3.pocket())` before sending.

### Exact-out variant (e.g. "I need exactly 1,000 USDC out")

```solidity
uint256 maxIn = PSM3.previewSwapExactOut(SUSDS, USDC, 1_000e6) * 10005 / 10000;
IERC20(SUSDS).approve(address(PSM3), maxIn);

PSM3.swapExactOut(SUSDS, USDC, 1_000e6, maxIn, msg.sender, 0);
```

# Ethereum mainnet: USDC ⇄ USDS ⇄ sUSDS

Mainnet does not run PSM3. Instead, the Sky/MakerDAO **Lite PSM** holds USDC
against DAI, and Spark deploys a thin **`UsdsPsmWrapper`** in front of it that
joins/exits the legacy DAI plumbing internally so end users only ever see USDS.
The result is a one-call USDC ⇄ USDS swap with no manual DAI hop.

To go all the way to yield (sUSDS), wrap the resulting USDS using the standard
ERC-4626 sUSDS contract. That's the only extra step.

## Addresses (Ethereum mainnet, chain ID 1)

| Contract                                   | Address                                                                                                                      | Notes                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Spark: UsdsPsmWrapper                      | [`0xA188EEC8F81263234dA3622A406892F3D630f98c`](https://etherscan.io/address/0xA188EEC8F81263234dA3622A406892F3D630f98c#code) | Routes USDC↔USDS via the Lite PSM, verified `UsdsPsmWrapper.sol`      |
| Sky: USDS Lite PSM (`MCD_LITE_PSM_USDC_A`) | `0xf6e72Db5454dd049d0788e411b06CfAF16853042`                                                                                 | Underlying PSM the wrapper wraps; do not call directly for USDS swaps |
| USDC                                       | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`                                                                                 | 6 decimals                                                            |
| USDS                                       | `0xdC035D45d973E3EC169d2276DDab16f1e407384F`                                                                                 | 18 decimals                                                           |
| sUSDS (ERC-4626)                           | `0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD`                                                                                 | 18 decimals, asset = USDS                                             |
| UsdsJoin                                   | `0x3C0f895007CA717Aa01c8693e59DF1e8C3777FEB`                                                                                 | Internal — used by the wrapper, not by callers                        |

## Function signatures

### `UsdsPsmWrapper`

```solidity
// USDC -> USDS (sells USDC "gem" into the PSM, exits as USDS)
function sellGem(address usr, uint256 gemAmt) external returns (uint256 usdsOutWad);

// USDS -> USDC (deposits USDS, buys USDC "gem" out of the PSM)
function buyGem(address usr, uint256 gemAmt) external returns (uint256 usdsInWad);
```

### `sUSDS` (ERC-4626, the standard subset)

```solidity
function deposit(uint256 assets, address receiver) external returns (uint256 shares);
function mint(uint256 shares, address receiver) external returns (uint256 assets);
function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);

function convertToShares(uint256 assets) external view returns (uint256 shares);
function convertToAssets(uint256 shares) external view returns (uint256 assets);
function previewDeposit(uint256 assets) external view returns (uint256 shares);
function previewRedeem(uint256 shares) external view returns (uint256 assets);
```

## Parameter notes

**`UsdsPsmWrapper.sellGem(usr, gemAmt)` — USDC → USDS**

- `gemAmt` is USDC in **native 6 decimals** (`100e6` = 100 USDC).
- `usr` is the recipient of the resulting USDS.
- Caller must `approve(wrapper, gemAmt)` on the **USDC** token first.
- Returns `usdsOutWad`, the USDS minted to `usr` in 18-dec wad. With `tin = 0`
  (current Sky governance setting) the math is `usdsOutWad = gemAmt * 1e12`,
  i.e. exact 1:1.

**`UsdsPsmWrapper.buyGem(usr, gemAmt)` — USDS → USDC**

- `gemAmt` is the **desired USDC output** in 6 decimals — this is `swapExactOut`
  semantics, not exact-in. There is no exact-in helper; if you have exactly
  `X` USDS and want it all converted, compute `gemAmt = X / (1e12 + tout / 1e6)`
  off-chain and round down.
- Caller must `approve(wrapper, usdsInWad)` on the **USDS** token, where
  `usdsInWad = gemAmt * 1e12 + gemAmt * 1e12 * tout() / 1e18`. Easiest path:
  read `tout()`, compute, then approve a small buffer above it.
- `usr` receives the USDC; the function returns the USDS actually pulled.
- Reverts if the Lite PSM's USDC `pocket` doesn't have `gemAmt` available
  (rare in practice — the Lite PSM is pre-loaded by Maker keepers and the
  `buf` is large; check `IERC20(USDC).balanceOf(pocket())` if you're moving
  size).

**Fees.** `tin` and `tout` are the only friction. Both are governance-set on
the underlying Lite PSM and have been **0** since launch, but always read them
on-chain rather than hardcoding. The wrapper just forwards them.

**`sUSDS.deposit(assets, receiver)` — USDS → sUSDS**

- `assets` is USDS in 18 decimals. `receiver` gets the sUSDS shares.
- Caller must `approve(sUSDS, assets)` on the **USDS** token first.
- Returns `shares`. Because sUSDS price grows monotonically with the SSR,
  `shares < assets` always (and the gap widens over time).

**`sUSDS.redeem(shares, receiver, owner)` — sUSDS → USDS**

- Burns `shares` from `owner` (must equal `msg.sender` or have allowance) and
  sends `assets` USDS to `receiver`.
- Use `redeem` when you want to fully exit a position; use `withdraw` when you
  want an exact USDS amount out.

## Worked example: USDC → sUSDS (full deposit-into-yield path)

```solidity
IERC20  usdc        = IERC20(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);
IERC20  usds        = IERC20(0xdC035D45d973E3EC169d2276DDab16f1e407384F);
IERC4626 sUsds      = IERC4626(0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD);
IUsdsPsmWrapper wrap = IUsdsPsmWrapper(0xA188EEC8F81263234dA3622A406892F3D630f98c);

uint256 usdcIn = 1_000e6;                          // 1,000 USDC

// 1. USDC -> USDS via the wrapper
usdc.approve(address(wrap), usdcIn);
uint256 usdsOut = wrap.sellGem(address(this), usdcIn);   // ~1,000e18 USDS (tin = 0)

// 2. USDS -> sUSDS via ERC-4626 deposit
usds.approve(address(sUsds), usdsOut);
uint256 sharesOut = sUsds.deposit(usdsOut, msg.sender);  // sUSDS to the end user
```

Net effect: caller spent 1,000 USDC, end user holds `sharesOut` sUSDS that
accrues the SSR until they exit.

## Worked example: sUSDS → USDC (full exit path)

```solidity
uint256 sharesIn = sUsds.balanceOf(msg.sender);

// 1. Pull sUSDS, redeem to USDS
sUsds.transferFrom(msg.sender, address(this), sharesIn);
uint256 usdsOut = sUsds.redeem(sharesIn, address(this), address(this));

// 2. USDS -> USDC via the wrapper.
//    buyGem is exact-out, so back out gemAmt from usdsOut and current tout.
uint256 tout    = wrap.tout();                                    // 1e18-precision
uint256 gemAmt  = (usdsOut * 1e18) / ((1e18 + tout) * 1e12);      // floor, USDC 6dec
uint256 needed  = gemAmt * 1e12 + gemAmt * 1e12 * tout / 1e18;    // USDS to approve

usds.approve(address(wrap), needed);
wrap.buyGem(msg.sender, gemAmt);                                  // USDC to user
```
