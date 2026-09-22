import {
  validateIxbrlDocument as validateIxbrlDocumentEngine,
  FRS102_SCHEMA_LOCK as ENGINE_SCHEMA_LOCK,
} from '@taxpro/tax-engine';
import type { IxbrlValidationInput, IxbrlValidationResult } from '@taxpro/tax-engine';

export type { IxbrlValidationInput, IxbrlValidationResult } from '@taxpro/tax-engine';
export const FRS102_SCHEMA_LOCK = ENGINE_SCHEMA_LOCK;

/**
 * iXBRL structural conformance validation.
 *
 * Forwarder: the pure checks live in @taxpro/tax-engine
 * (uk-frs102-s29/export-schema-validator.ts) so generated documents can be
 * validated without the backend. Route contracts and result shapes are
 * unchanged. Still structural conformance, not XSD validation.
 */
export function validateIxbrlDocument(doc: IxbrlValidationInput): IxbrlValidationResult {
  return validateIxbrlDocumentEngine(doc);
}
