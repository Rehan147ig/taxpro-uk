/**
 * Feature flags for the messy-data ingest hardening pass.
 *
 * All four flags default OFF. Enable per-tenant via environment:
 *   INTAKE_XLSX=true
 *   INTAKE_SIGN_CONVENTION=true
 *   INTAKE_PRIOR_BRIDGE=true
 *   INTAKE_ASSET_REGISTER=true
 *
 * The flags are exposed read-only to the UI via GET /api/config/flags.
 * Intake routes enforce them (403 FEATURE_DISABLED when off) so pilots can
 * be unblocked incrementally: ship Feature 1 first, follow with 2-4.
 */

function flag(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function isIntakeXlsxEnabled(): boolean {
  return flag('INTAKE_XLSX');
}

export function isIntakeSignConventionEnabled(): boolean {
  return flag('INTAKE_SIGN_CONVENTION');
}

export function isIntakePriorBridgeEnabled(): boolean {
  return flag('INTAKE_PRIOR_BRIDGE');
}

export function isIntakeAssetRegisterEnabled(): boolean {
  return flag('INTAKE_ASSET_REGISTER');
}

export function getIntakeFlags() {
  return {
    INTAKE_XLSX: isIntakeXlsxEnabled(),
    INTAKE_SIGN_CONVENTION: isIntakeSignConventionEnabled(),
    INTAKE_PRIOR_BRIDGE: isIntakePriorBridgeEnabled(),
    INTAKE_ASSET_REGISTER: isIntakeAssetRegisterEnabled(),
  };
}

export type IntakeFlags = ReturnType<typeof getIntakeFlags>;
