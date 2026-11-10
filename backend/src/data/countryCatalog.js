import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const isoCountries = require('i18n-iso-countries');
isoCountries.registerLocale(require('i18n-iso-countries/langs/en.json'));

const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
const alpha2Codes = Object.keys(isoCountries.getAlpha2Codes()).sort();

export const COUNTRY_CATALOG = Object.freeze(alpha2Codes.map((countryCode) => Object.freeze({
  countryCode,
  countryName: displayNames.of(countryCode) ?? isoCountries.getName(countryCode, 'en'),
})));

const COUNTRY_BY_CODE = new Map(COUNTRY_CATALOG.map((country) => [country.countryCode, country]));

export function normalizeCountryCode(value) {
  if (value === null) return { value: null };
  if (typeof value !== 'string') return { error: 'countryCode must be an ISO 3166-1 alpha-2 code or null' };
  const countryCode = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode) || !COUNTRY_BY_CODE.has(countryCode)) {
    return { error: 'countryCode must be a valid ISO 3166-1 alpha-2 code or null' };
  }
  return { value: countryCode };
}

export function countryNameForCode(countryCode) {
  return typeof countryCode === 'string' ? COUNTRY_BY_CODE.get(countryCode)?.countryName ?? null : null;
}

export function isValidCountryCode(countryCode) {
  return typeof countryCode === 'string' && COUNTRY_BY_CODE.has(countryCode);
}
