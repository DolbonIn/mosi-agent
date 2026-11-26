/**
 * PART C, what a price already assumes: the identities of methods A (Gordon), C (normal PE) and the HBM / conventional
 * split (C7). Percentages in and out (11 means 11 %), no rounding: the caller formats.
 *
 * Reproduced against the master prompt's own tables (test/valuation.test.ts):
 * - C2 reproduces with PBR = market cap / B0 (1,203.74 / 614.11 = 1.960, 823.47 / 309.09 = 2.664), not with the C1
 *   row's 1.97x / 2.70x.
 * - C4 reproduces with the BPS behind C1's "2027E ROE" (EPS27 / ROE27), all but one cell: Samsung at 8x is 13.0 %, the
 *   table says 13.1 %.
 * - C7 reproduces as a revenue-weighted mix, all but two rows: Samsung 25 % / −20 % is −58.9 % (the table −59.0 %, the
 *   blend −49.25 % before its rounding to −49.2 %), and Hynix "50 % / 0 %" is impossible as printed (−101.4 %); its
 *   −92.2 % is the 45 % row.
 * Methods B (residual income), D (implied COE) and the ASP conversion (A′, C6) need inputs and steps the prompt does not
 * give, so they are not here.
 */

/** C2: P/B = (ROE − g) / (COE − g) ⇔ ROE = g + P/B × (COE − g), the permanent ROE a price-to-book implies */
export function gordonImpliedRoe(pbr: number, coe: number, g: number): number {
  return g + pbr * (coe - g);
}

/** C2's other columns: an implied ROE as a share of the current one, and the discount (100 − share) */
export function shareOfCurrent(implied: number, current: number): { share: number; discount: number } | null {
  if (!(current > 0)) return null;
  const share = (implied / current) * 100;
  return { share, discount: 100 - share };
}

/** C4: at a normal PE the price implies EPS = price / PE; against the forward EPS, and as an ROE on a book value per share */
export function normalPe(price: number, pe: number, forwardEps: number, bps: number): { eps: number; vsForward: number; roe: number } | null {
  if (!(pe > 0 && forwardEps > 0 && bps > 0)) return null;
  const eps = price / pe;
  return { eps, vsForward: (eps / forwardEps) * 100, roe: (eps / bps) * 100 };
}

/** (1 + total / 100)^(1 / years) − 1, in %; null at or below −100 % */
export function annualized(total: number, years: number): number | null {
  if (!(total > -100) || !(years > 0)) return null;
  return ((1 + total / 100) ** (1 / years) - 1) * 100;
}

/**
 * C7: a blended price change split into HBM and conventional by HBM's revenue share (0–1):
 * blended = share × HBM + (1 − share) × conventional. Null when the needed conventional change is −100 % or worse (no
 * price can fall that far) or the share leaves no conventional part.
 */
export function conventionalChange(blended: number, hbmShare: number, hbmChange: number, years = 2): { total: number; annual: number } | null {
  if (!(hbmShare >= 0 && hbmShare < 1)) return null;
  const total = (blended - hbmShare * hbmChange) / (1 - hbmShare);
  const annual = annualized(total, years);
  return annual == null ? null : { total, annual };
}
