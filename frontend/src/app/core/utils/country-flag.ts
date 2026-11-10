/** Convert an ISO alpha-2 code into its Unicode flag, when supported by the platform font. */
export function countryFlag(countryCode: string | null | undefined): string {
  if (!countryCode || !/^[A-Za-z]{2}$/.test(countryCode)) return '🌐';
  return String.fromCodePoint(...countryCode.toUpperCase().split('').map((character) => 127397 + character.charCodeAt(0)));
}
