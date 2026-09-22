import type { Ct600Return } from './ct600.js';
import { validateCt600Rules } from '@taxpro/tax-engine';
import type { Ct600ValidationResult } from '@taxpro/tax-engine';

export type { Ct600Violation, Ct600ValidationResult } from '@taxpro/tax-engine';

/**
 * CT600 conformance validation against HMRC rules.
 *
 * Forwarder: the pure rule table lives in
 * @taxpro/tax-engine (uk-frs102-s29/export-schema-validator.ts) so the
 * engine package — and third parties — can validate returns standalone.
 * Route contracts and result shapes are unchanged.
 */
export function validateCt600Return(ct600: Ct600Return): Ct600ValidationResult {
  return validateCt600Rules(ct600);
}
