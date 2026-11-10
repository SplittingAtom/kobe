// The address ranges both proxies refuse live in one place (@kobe/address-policy, KOBE-58 review L6).
export {
  ALWAYS_DENIED_CIDRS,
  AddressPolicy,
  DEFAULT_DENIED_CIDRS,
  validateCidrs,
  validateInternalTargets,
  type AddressCheckOptions,
  type AddressPolicyOptions,
  type AddressVerdict,
} from "@kobe/address-policy";
