#!/usr/bin/env node
/**
 * Everything that builds the currency pages, in one file.
 *
 *   node tools/build.mjs              generate pages/currency/** then validate
 *   node tools/build.mjs --check      fail if the tree on disk is out of date
 *   node tools/build.mjs serve        jekyll serve on :4000
 *   node tools/build.mjs badges       re-download the store badges
 *   node tools/build.mjs currencies   refresh the supported-currency list
 *   node tools/build.mjs screenshots  re-import screenshots from fastlane
 *
 * Layout, top to bottom:
 *
 *   1. SITE          app identity, store ids, feature list
 *   2. FACTS         per-currency reference data (central bank, peg, wikidata)
 *   3. CURRENCIES    CLDR lookups built on FACTS
 *   4. LOCALES       the 15 published languages
 *   5. PAIRS         which pairs each language publishes
 *   6. TEXTSTATS     tokenising and n-gram overlap, used by the validator
 *   7. COPY          UI strings and page templates, one entry per language
 *   8. CORRIDORS     the hand-written per-pair prose, one entry per language
 *   9. RENDER        the two page templates
 *  10. GENERATE      writes the tree
 *  11. VALIDATE      the gate: refuses to ship pages that break the rules
 *  12. FETCH         the three one-shot importers
 *
 * Generation is deterministic: running it twice with no source change rewrites
 * nothing and moves no `dateModified`. There is no state file — each generated
 * page carries its own content hash and publication date in its front matter,
 * which Jekyll strips before serving.
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'pages', 'currency')

// --------------------------------------------------------------------------
// 1. SITE
// --------------------------------------------------------------------------

/** Site-wide constants shared by the generator and the validators. */
const SITE = {
  host: 'julien-millau.fr',
  url: 'https://julien-millau.fr',
  appName: 'Currency Converter & Exchange',
  twitter: '@devnied',
  /** 1200×630 exactly — the dimensions declared in the OG tags must be true. */
  ogImage: '/images/currency-converter/og.jpg',

  stores: {
    androidFree: 'com.devnied.currency.free',
    androidPro: 'com.devnied.currency.pro',
    appleId: '6760141868',
    // Verified against the iTunes lookup API, not assumed: the listing is named
    // "Currency Converter & Rates Pro" and requires iOS 18.6. Claiming a name
    // the App Store does not use breaks the entity association the JSON-LD
    // exists to create.
    appleName: 'Currency Converter & Rates Pro',
    appleSlug: 'currency-converter-rates-pro',
    appleMinOs: '18.6',
    /**
     * App Store Connect provider token (App Analytics → Campaigns).
     * While this is empty the generator omits `pt`/`ct` everywhere: a `ct`
     * without a `pt` is not recorded by Apple, so emitting one is noise.
     */
    appleProviderToken: '',
  },

  /** Languages the app itself ships in — quoted in JSON-LD. */
  appLanguages: ['en', 'fr', 'es', 'de', 'it', 'pt', 'tr', 'pl', 'ru', 'ja', 'ko', 'zh-Hans', 'hi', 'ar', 'vi'],

  /** Feature list quoted in JSON-LD. Must stay consistent with store claims. */
  featureList: [
    'Converts 180+ world currencies',
    '20+ cryptocurrencies including Bitcoin and Ethereum',
    'Exchange rates refreshed multiple times daily',
    'Full offline conversion using the last saved rates',
    'Historical exchange rate charts from 1 day to 5 years',
    'Home-screen widget',
    'Customisable favourite currency pairs',
    'Search by country name, currency name or ISO 4217 code',
    'No account and no sign-in required',
  ],
}

// --------------------------------------------------------------------------
// 2. FACTS
// --------------------------------------------------------------------------

/**
 * Durable, checkable facts about each currency.
 *
 * These are the "tier A" facts the landing pages are built on: they change on a
 * scale of years, so they can safely live in static HTML — unlike an exchange
 * rate, which is fetched at runtime and never committed.
 *
 * `wikidata` and `bank` were extracted once, on 2026-08-02, from the Wikidata
 * SPARQL endpoint (P498 → ISO 4217 code, P17 → issuing country, P1304 → central
 * bank, P856 → official site), then hand-corrected where a shared currency
 * resolved to the wrong issuer: EUR came back as a national central bank and
 * HKD as the PBoC. There is no refresh script — re-running the query would undo
 * those corrections, so this table is edited by hand.
 *
 * `minorUnit` is the ISO 4217 exponent, which is deliberately NOT CLDR's
 * display precision: CLDR shows HUF, COP, IDR and PKR with no decimals because
 * that is local practice, while ISO assigns them an exponent of 2. The pages
 * quote ISO in the facts table and format amounts with CLDR.
 *
 * `peg` is present only for currencies with a published, standing peg or band,
 * and `since` dates the value quoted — not the arrangement's origin, which can
 * be much older (see HKD). marketKind() in render.mjs decides which of the
 * three explanations a page gets from it.
 */
const FACTS = {
  USD: { wikidata: 'Q4917', bank: 'Federal Reserve System', bankUrl: 'https://www.federalreserve.gov/', minorUnit: 2 },
  EUR: { wikidata: 'Q4916', bank: 'European Central Bank', bankUrl: 'https://www.ecb.europa.eu/', minorUnit: 2 },
  GBP: { wikidata: 'Q25224', bank: 'Bank of England', bankUrl: 'https://www.bankofengland.co.uk/', minorUnit: 2 },
  JPY: { wikidata: 'Q8146', bank: 'Bank of Japan', bankUrl: 'https://www.boj.or.jp/en/', minorUnit: 0 },
  CHF: { wikidata: 'Q25344', bank: 'Swiss National Bank', bankUrl: 'https://www.snb.ch/', minorUnit: 2 },
  CAD: { wikidata: 'Q1104069', bank: 'Bank of Canada', bankUrl: 'https://www.bankofcanada.ca/', minorUnit: 2 },
  AUD: { wikidata: 'Q259502', bank: 'Reserve Bank of Australia', bankUrl: 'https://www.rba.gov.au/', minorUnit: 2 },
  NZD: { wikidata: 'Q1472704', bank: 'Reserve Bank of New Zealand', bankUrl: 'https://www.rbnz.govt.nz/', minorUnit: 2 },

  PLN: { wikidata: 'Q123213', bank: 'Narodowy Bank Polski', bankUrl: 'https://nbp.pl/en/', minorUnit: 2 },
  RON: { wikidata: 'Q131645', bank: 'National Bank of Romania', bankUrl: 'https://www.bnr.ro/', minorUnit: 2 },
  CZK: { wikidata: 'Q131016', bank: 'Czech National Bank', bankUrl: 'https://www.cnb.cz/en/', minorUnit: 2 },
  HUF: { wikidata: 'Q47190', bank: 'Magyar Nemzeti Bank', bankUrl: 'https://www.mnb.hu/en', minorUnit: 2 },
  SEK: { wikidata: 'Q122922', bank: 'Sveriges Riksbank', bankUrl: 'https://www.riksbank.se/en-gb/', minorUnit: 2 },
  NOK: { wikidata: 'Q132643', bank: 'Norges Bank', bankUrl: 'https://www.norges-bank.no/en/', minorUnit: 2 },
  DKK: {
    wikidata: 'Q25417', bank: 'Danmarks Nationalbank', bankUrl: 'https://www.nationalbanken.dk/en', minorUnit: 2,
    peg: { against: 'EUR', since: 1999, kind: 'erm2' },
  },
  UAH: { wikidata: 'Q81893', bank: 'National Bank of Ukraine', bankUrl: 'https://bank.gov.ua/en/', minorUnit: 2 },
  RUB: { wikidata: 'Q41044', bank: 'Bank of Russia', bankUrl: 'https://www.cbr.ru/eng/', minorUnit: 2 },
  TRY: { wikidata: 'Q172872', bank: 'Central Bank of the Republic of Türkiye', bankUrl: 'https://www.tcmb.gov.tr/', minorUnit: 2 },

  MXN: { wikidata: 'Q4730', bank: 'Banco de México', bankUrl: 'https://www.banxico.org.mx/', minorUnit: 2 },
  BRL: { wikidata: 'Q173117', bank: 'Banco Central do Brasil', bankUrl: 'https://www.bcb.gov.br/en', minorUnit: 2 },
  ARS: { wikidata: 'Q199578', bank: 'Banco Central de la República Argentina', bankUrl: 'https://www.bcra.gob.ar/', minorUnit: 2 },
  COP: { wikidata: 'Q244819', bank: 'Banco de la República', bankUrl: 'https://www.banrep.gov.co/en', minorUnit: 2 },
  CLP: { wikidata: 'Q200050', bank: 'Banco Central de Chile', bankUrl: 'https://www.bcentral.cl/en/', minorUnit: 0 },
  PEN: { wikidata: 'Q204656', bank: 'Banco Central de Reserva del Perú', bankUrl: 'https://www.bcrp.gob.pe/', minorUnit: 2 },
  UYU: { wikidata: 'Q209272', bank: 'Banco Central del Uruguay', bankUrl: 'https://www.bcu.gub.uy/', minorUnit: 2 },
  BOB: { wikidata: 'Q200737', bank: 'Banco Central de Bolivia', bankUrl: 'https://www.bcb.gob.bo/', minorUnit: 2 },
  DOP: { wikidata: 'Q242922', bank: 'Banco Central de la República Dominicana', bankUrl: 'https://www.bancentral.gov.do/', minorUnit: 2 },
  GTQ: { wikidata: 'Q207396', bank: 'Banco de Guatemala', bankUrl: 'https://www.banguat.gob.gt/', minorUnit: 2 },
  CRC: { wikidata: 'Q242915', bank: 'Banco Central de Costa Rica', bankUrl: 'https://www.bccr.fi.cr/', minorUnit: 2 },

  CNY: { wikidata: 'Q39099', bank: "People's Bank of China", bankUrl: 'http://www.pbc.gov.cn/en/', minorUnit: 2 },
  HKD: {
    wikidata: 'Q31015', bank: 'Hong Kong Monetary Authority', bankUrl: 'https://www.hkma.gov.hk/eng/', minorUnit: 2,
    // The Linked Exchange Rate System dates from 17 October 1983, but it began
    // as a single 7.80 rate; the 7.75–7.85 convertibility zone quoted here was
    // only introduced in May 2005. Pairing the band with 1983 states something
    // false, so `since` belongs to the band, not to the peg's origin.
    peg: { against: 'USD', since: 2005, kind: 'band' },
  },
  TWD: { wikidata: 'Q208526', bank: 'Central Bank of the Republic of China (Taiwan)', bankUrl: 'https://www.cbc.gov.tw/en/', minorUnit: 2 },
  KRW: { wikidata: 'Q202040', bank: 'Bank of Korea', bankUrl: 'https://www.bok.or.kr/eng/', minorUnit: 0 },
  SGD: { wikidata: 'Q190951', bank: 'Monetary Authority of Singapore', bankUrl: 'https://www.mas.gov.sg/', minorUnit: 2 },
  THB: { wikidata: 'Q177882', bank: 'Bank of Thailand', bankUrl: 'https://www.bot.or.th/en/', minorUnit: 2 },
  VND: { wikidata: 'Q192090', bank: 'State Bank of Vietnam', bankUrl: 'https://www.sbv.gov.vn/', minorUnit: 0 },
  IDR: { wikidata: 'Q41588', bank: 'Bank Indonesia', bankUrl: 'https://www.bi.go.id/en/', minorUnit: 2 },
  PHP: { wikidata: 'Q17193', bank: 'Bangko Sentral ng Pilipinas', bankUrl: 'https://www.bsp.gov.ph/', minorUnit: 2 },
  MYR: { wikidata: 'Q163712', bank: 'Bank Negara Malaysia', bankUrl: 'https://www.bnm.gov.my/', minorUnit: 2 },
  INR: { wikidata: 'Q80524', bank: 'Reserve Bank of India', bankUrl: 'https://www.rbi.org.in/', minorUnit: 2 },
  PKR: { wikidata: 'Q188289', bank: 'State Bank of Pakistan', bankUrl: 'https://www.sbp.org.pk/', minorUnit: 2 },
  BDT: { wikidata: 'Q194453', bank: 'Bangladesh Bank', bankUrl: 'https://www.bb.org.bd/', minorUnit: 2 },
  NPR: {
    wikidata: 'Q202895', bank: 'Nepal Rastra Bank', bankUrl: 'https://www.nrb.org.np/', minorUnit: 2,
    peg: { against: 'INR', since: 1993, kind: 'fixed' },
  },
  LKR: { wikidata: 'Q4596', bank: 'Central Bank of Sri Lanka', bankUrl: 'https://www.cbsl.gov.lk/', minorUnit: 2 },

  AED: {
    wikidata: 'Q200294', bank: 'Central Bank of the UAE', bankUrl: 'https://www.centralbank.ae/en/', minorUnit: 2,
    peg: { against: 'USD', since: 1997, kind: 'fixed' },
  },
  SAR: {
    wikidata: 'Q199857', bank: 'Saudi Central Bank', bankUrl: 'https://www.sama.gov.sa/en-US/', minorUnit: 2,
    peg: { against: 'USD', since: 1986, kind: 'fixed' },
  },
  QAR: {
    wikidata: 'Q206386', bank: 'Qatar Central Bank', bankUrl: 'https://www.qcb.gov.qa/en/', minorUnit: 2,
    peg: { against: 'USD', since: 2001, kind: 'fixed' },
  },
  KWD: {
    wikidata: 'Q193098', bank: 'Central Bank of Kuwait', bankUrl: 'https://www.cbk.gov.kw/en/', minorUnit: 3,
    peg: { against: 'basket', kind: 'basket', since: 2007 },
  },
  EGP: { wikidata: 'Q199462', bank: 'Central Bank of Egypt', bankUrl: 'https://www.cbe.org.eg/en', minorUnit: 2 },
  MAD: { wikidata: 'Q200192', bank: 'Bank Al-Maghrib', bankUrl: 'https://www.bkam.ma/en', minorUnit: 2 },
  DZD: { wikidata: 'Q199674', bank: 'Banque d\u2019Algérie', bankUrl: 'https://www.bank-of-algeria.dz/', minorUnit: 2 },
  TND: { wikidata: 'Q4602', bank: 'Banque Centrale de Tunisie', bankUrl: 'https://www.bct.gov.tn/', minorUnit: 3 },
  ZAR: { wikidata: 'Q181907', bank: 'South African Reserve Bank', bankUrl: 'https://www.resbank.co.za/', minorUnit: 2 },
  NGN: { wikidata: 'Q203567', bank: 'Central Bank of Nigeria', bankUrl: 'https://www.cbn.gov.ng/', minorUnit: 2 },
  XOF: {
    wikidata: 'Q861690', bank: 'Central Bank of West African States (BCEAO)', bankUrl: 'https://www.bceao.int/', minorUnit: 0,
    peg: { against: 'EUR', since: 1999, kind: 'fixed' },
  },
  XAF: {
    wikidata: 'Q847739', bank: 'Bank of Central African States (BEAC)', bankUrl: 'https://www.beac.int/', minorUnit: 0,
    peg: { against: 'EUR', since: 1999, kind: 'fixed' },
  },
}

// --------------------------------------------------------------------------
// 3. CURRENCIES
// --------------------------------------------------------------------------

/**
 * Currency reference data.
 *
 * Localized currency *names*, *symbols* and *country names* are never
 * hand-translated: they come from the CLDR data bundled with Node's Intl API,
 * so all 15 web locales get the canonical localized wording for free.
 *
 * Everything CLDR does not carry — flags, issuing country, whether a code is
 * crypto — lives in CURRENCIES. Durable per-currency facts (ISO 4217 exponent,
 * central bank, Wikidata id, peg) live in ./currency-facts.mjs.
 */

/** Currencies that can appear in a pair, with their issuing country/region. */
const CURRENCIES = {
  // --- majors -------------------------------------------------------------
  USD: { country: 'US', flag: '🇺🇸' },
  EUR: { country: 'EU', flag: '🇪🇺' },
  GBP: { country: 'GB', flag: '🇬🇧' },
  JPY: { country: 'JP', flag: '🇯🇵' },
  CHF: { country: 'CH', flag: '🇨🇭' },
  CAD: { country: 'CA', flag: '🇨🇦' },
  AUD: { country: 'AU', flag: '🇦🇺' },
  NZD: { country: 'NZ', flag: '🇳🇿' },
  // --- europe -------------------------------------------------------------
  PLN: { country: 'PL', flag: '🇵🇱' },
  RON: { country: 'RO', flag: '🇷🇴' },
  CZK: { country: 'CZ', flag: '🇨🇿' },
  HUF: { country: 'HU', flag: '🇭🇺' },
  SEK: { country: 'SE', flag: '🇸🇪' },
  NOK: { country: 'NO', flag: '🇳🇴' },
  DKK: { country: 'DK', flag: '🇩🇰' },
  UAH: { country: 'UA', flag: '🇺🇦' },
  RUB: { country: 'RU', flag: '🇷🇺' },
  TRY: { country: 'TR', flag: '🇹🇷' },
  // --- americas -----------------------------------------------------------
  MXN: { country: 'MX', flag: '🇲🇽' },
  BRL: { country: 'BR', flag: '🇧🇷' },
  ARS: { country: 'AR', flag: '🇦🇷' },
  COP: { country: 'CO', flag: '🇨🇴' },
  CLP: { country: 'CL', flag: '🇨🇱' },
  PEN: { country: 'PE', flag: '🇵🇪' },
  UYU: { country: 'UY', flag: '🇺🇾' },
  BOB: { country: 'BO', flag: '🇧🇴' },
  DOP: { country: 'DO', flag: '🇩🇴' },
  GTQ: { country: 'GT', flag: '🇬🇹' },
  CRC: { country: 'CR', flag: '🇨🇷' },
  // --- asia ---------------------------------------------------------------
  CNY: { country: 'CN', flag: '🇨🇳' },
  HKD: { country: 'HK', flag: '🇭🇰' },
  TWD: { country: 'TW', flag: '🇹🇼' },
  KRW: { country: 'KR', flag: '🇰🇷' },
  SGD: { country: 'SG', flag: '🇸🇬' },
  THB: { country: 'TH', flag: '🇹🇭' },
  VND: { country: 'VN', flag: '🇻🇳' },
  IDR: { country: 'ID', flag: '🇮🇩' },
  PHP: { country: 'PH', flag: '🇵🇭' },
  MYR: { country: 'MY', flag: '🇲🇾' },
  INR: { country: 'IN', flag: '🇮🇳' },
  PKR: { country: 'PK', flag: '🇵🇰' },
  BDT: { country: 'BD', flag: '🇧🇩' },
  NPR: { country: 'NP', flag: '🇳🇵' },
  LKR: { country: 'LK', flag: '🇱🇰' },
  // --- middle east & africa -----------------------------------------------
  AED: { country: 'AE', flag: '🇦🇪' },
  SAR: { country: 'SA', flag: '🇸🇦' },
  QAR: { country: 'QA', flag: '🇶🇦' },
  KWD: { country: 'KW', flag: '🇰🇼' },
  EGP: { country: 'EG', flag: '🇪🇬' },
  MAD: { country: 'MA', flag: '🇲🇦' },
  DZD: { country: 'DZ', flag: '🇩🇿' },
  TND: { country: 'TN', flag: '🇹🇳' },
  ZAR: { country: 'ZA', flag: '🇿🇦' },
  NGN: { country: 'NG', flag: '🇳🇬' },
  XOF: { country: 'SN', flag: '🌍', region: 'UEMOA' },
  XAF: { country: 'CM', flag: '🌍', region: 'CEMAC' },
}

/** Localized display name for a currency, from CLDR. */
function currencyName(code, locale) {
  return new Intl.DisplayNames([locale], { type: 'currency' }).of(code)
}

/** Localized symbol ("$", "€", "₺"…), falling back to the ISO code. */
function currencySymbol(code, locale) {
  try {
    const part = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
    })
      .formatToParts(1)
      .find(p => p.type === 'currency')
    return part ? part.value : code
  } catch {
    return code
  }
}

/** Localized country/region name for a currency ("Suisse", "スイス"…). */
function countryName(code, locale) {
  const region = CURRENCIES[code]?.country
  if (!region) return null
  return new Intl.DisplayNames([locale], { type: 'region' }).of(region)
}

/**
 * ISO 4217 minor-unit exponent — the normative "how many decimal places does
 * this currency legally have" figure quoted on the page.
 *
 * Deliberately NOT the same as CLDR's display precision: CLDR renders HUF, COP,
 * IDR and PKR with 0 decimals because that is local practice, while ISO 4217
 * assigns them an exponent of 2. Quote ISO in the facts table, format with CLDR.
 */
function minorUnit(code) {
  return FACTS[code]?.minorUnit ?? 2
}

// --------------------------------------------------------------------------
// 4. LOCALES
// --------------------------------------------------------------------------

/**
 * The web locales the currency landing pages are published in.
 *
 * One entry = one language edition of the site. Each maps back to the fastlane
 * store listing it inherits its keywords and screenshots from, so the web copy
 * and the store copy reinforce the same terms.
 *
 * Fields:
 *   code      path prefix and internal key ('en' is served from the root)
 *   hreflang  value used in <link rel="alternate" hreflang> and the sitemap
 *   htmlLang  value used in <html lang>
 *   dir       'ltr' | 'rtl'
 *   intl      BCP-47 tag handed to Intl for names, symbols and number formats
 *   fastlane  source folder under fastlane/metadata/android
 *   playBadge  Google Play badge language (play.google.com/intl/<code>/badges/…)
 *   appleBadge Apple badge locale (toolbox.marketingtools.apple.com v2 API).
 *              Apple publishes no Hindi or Arabic badge, so those fall back to
 *              en-us — which is what Apple's own guidelines prescribe.
 *   apiLang   `lang` value the app sends to its own backend. The app derives it
 *             from java.util.Locale#toString, which is underscore-separated —
 *             so it is the fastlane folder name with the hyphen swapped.
 *   playHl    Play Store `hl` parameter
 *   playGl    Play Store `gl` parameter (primary market for that language)
 *   appleCc   App Store country segment (…/<cc>/app/…)
 *   slug      localized "currency converter" slug used to build page URLs
 *   name      language name in the language itself (for the language switcher)
 */
const WEB_LOCALES = [
  {
    code: 'en',
    flag: '🇬🇧',
    playBadge: 'en',
    appleBadge: 'en-us',
    hreflang: 'en',
    htmlLang: 'en',
    dir: 'ltr',
    intl: 'en',
    fastlane: 'en-US',
    playHl: 'en',
    playGl: 'US',
    appleCc: 'us',
    slug: 'currency-converter',
    name: 'English',
    ogLocale: 'en_US',
  },
  {
    code: 'fr',
    flag: '🇫🇷',
    playBadge: 'fr',
    appleBadge: 'fr-fr',
    hreflang: 'fr',
    htmlLang: 'fr',
    dir: 'ltr',
    intl: 'fr',
    fastlane: 'fr-FR',
    playHl: 'fr',
    playGl: 'FR',
    appleCc: 'fr',
    slug: 'convertisseur-devises',
    name: 'Français',
    ogLocale: 'fr_FR',
    appleL: 'fr-FR',
  },
  {
    code: 'es',
    flag: '🇪🇸',
    playBadge: 'es',
    appleBadge: 'es-es',
    hreflang: 'es',
    htmlLang: 'es',
    dir: 'ltr',
    intl: 'es',
    fastlane: 'es-ES',
    playHl: 'es',
    playGl: 'ES',
    appleCc: 'es',
    slug: 'conversor-divisas',
    name: 'Español',
    ogLocale: 'es_ES',
    appleL: 'es-ES',
  },
  {
    code: 'de',
    flag: '🇩🇪',
    playBadge: 'de',
    appleBadge: 'de-de',
    hreflang: 'de',
    htmlLang: 'de',
    dir: 'ltr',
    intl: 'de',
    fastlane: 'de-DE',
    playHl: 'de',
    playGl: 'DE',
    appleCc: 'de',
    slug: 'waehrungsrechner',
    name: 'Deutsch',
    ogLocale: 'de_DE',
    appleL: 'de',
  },
  {
    code: 'it',
    flag: '🇮🇹',
    playBadge: 'it',
    appleBadge: 'it-it',
    hreflang: 'it',
    htmlLang: 'it',
    dir: 'ltr',
    intl: 'it',
    fastlane: 'it-IT',
    playHl: 'it',
    playGl: 'IT',
    appleCc: 'it',
    slug: 'convertitore-valute',
    name: 'Italiano',
    ogLocale: 'it_IT',
    appleL: 'it',
  },
  {
    code: 'pt',
    flag: '🇵🇹',
    playBadge: 'pt-br',
    appleBadge: 'pt-br',
    hreflang: 'pt',
    htmlLang: 'pt',
    dir: 'ltr',
    intl: 'pt-BR',
    fastlane: 'pt-BR',
    playHl: 'pt-BR',
    playGl: 'BR',
    appleCc: 'br',
    slug: 'conversor-moedas',
    name: 'Português',
    ogLocale: 'pt_BR',
    appleL: 'pt-BR',
  },
  {
    code: 'ru',
    flag: '🇷🇺',
    playBadge: 'ru',
    appleBadge: 'ru-ru',
    hreflang: 'ru',
    htmlLang: 'ru',
    dir: 'ltr',
    intl: 'ru',
    fastlane: 'ru-RU',
    playHl: 'ru',
    playGl: 'RU',
    appleCc: 'ru',
    slug: 'konverter-valyut',
    name: 'Русский',
    ogLocale: 'ru_RU',
    appleL: 'ru',
  },
  {
    code: 'tr',
    flag: '🇹🇷',
    playBadge: 'tr',
    appleBadge: 'tr-tr',
    hreflang: 'tr',
    htmlLang: 'tr',
    dir: 'ltr',
    intl: 'tr',
    fastlane: 'tr-TR',
    playHl: 'tr',
    playGl: 'TR',
    appleCc: 'tr',
    slug: 'doviz-cevirici',
    name: 'Türkçe',
    ogLocale: 'tr_TR',
    appleL: 'tr',
  },
  {
    code: 'pl',
    flag: '🇵🇱',
    playBadge: 'pl',
    appleBadge: 'pl-pl',
    hreflang: 'pl',
    htmlLang: 'pl',
    dir: 'ltr',
    intl: 'pl',
    fastlane: 'pl-PL',
    playHl: 'pl',
    playGl: 'PL',
    appleCc: 'pl',
    slug: 'przelicznik-walut',
    name: 'Polski',
    ogLocale: 'pl_PL',
    appleL: 'pl',
  },
  {
    code: 'ja',
    flag: '🇯🇵',
    playBadge: 'ja',
    appleBadge: 'ja-jp',
    hreflang: 'ja',
    htmlLang: 'ja',
    dir: 'ltr',
    intl: 'ja',
    fastlane: 'ja-JP',
    playHl: 'ja',
    playGl: 'JP',
    appleCc: 'jp',
    slug: 'kawase-keisan',
    name: '日本語',
    ogLocale: 'ja_JP',
    appleL: 'ja',
  },
  {
    code: 'ko',
    flag: '🇰🇷',
    playBadge: 'ko',
    appleBadge: 'ko-kr',
    hreflang: 'ko',
    htmlLang: 'ko',
    dir: 'ltr',
    intl: 'ko',
    fastlane: 'ko-KR',
    playHl: 'ko',
    playGl: 'KR',
    appleCc: 'kr',
    slug: 'hwanyul-gyesangi',
    name: '한국어',
    ogLocale: 'ko_KR',
    appleL: 'ko',
  },
  {
    code: 'zh',
    flag: '🇨🇳',
    playBadge: 'zh-cn',
    appleBadge: 'zh-cn',
    hreflang: 'zh-Hans',
    htmlLang: 'zh-Hans',
    dir: 'ltr',
    intl: 'zh-CN',
    fastlane: 'zh-CN',
    playHl: 'zh-CN',
    playGl: 'HK',
    // Google Play does not operate in mainland China, so the Play link targets
    // Hong Kong — but the App Store does, and the `cn` storefront is the only
    // one carrying the localized listing (汇率转换器・货币汇率 Pro). Pointing at
    // `hk` served Simplified Chinese readers the English page.
    appleCc: 'cn',
    // The `cn` listing has its own percent-encoded Chinese slug, so this URL is
    // built from the numeric id alone, which Apple resolves in any storefront.
    appleSlug: '',
    slug: 'huilv-huansuan',
    name: '简体中文',
    ogLocale: 'zh_CN',
    appleL: 'zh-Hans',
  },
  {
    code: 'hi',
    flag: '🇮🇳',
    playBadge: 'hi',
    appleBadge: 'en-us',
    hreflang: 'hi',
    htmlLang: 'hi',
    dir: 'ltr',
    intl: 'hi',
    fastlane: 'hi-IN',
    playHl: 'hi',
    playGl: 'IN',
    appleCc: 'in',
    slug: 'currency-converter',
    name: 'हिन्दी',
    ogLocale: 'hi_IN',
    appleL: 'hi',
  },
  {
    code: 'ar',
    flag: '🇸🇦',
    playBadge: 'ar',
    appleBadge: 'en-us',
    hreflang: 'ar',
    htmlLang: 'ar',
    dir: 'rtl',
    intl: 'ar',
    fastlane: 'ar',
    playHl: 'ar',
    playGl: 'SA',
    appleCc: 'sa',
    slug: 'muhawil-omlat',
    name: 'العربية',
    ogLocale: 'ar_AE',
    appleL: 'ar',
  },
  {
    code: 'vi',
    flag: '🇻🇳',
    playBadge: 'vi',
    appleBadge: 'vi-vn',
    hreflang: 'vi',
    htmlLang: 'vi',
    dir: 'ltr',
    intl: 'vi',
    fastlane: 'vi',
    playHl: 'vi',
    playGl: 'VN',
    appleCc: 'vn',
    slug: 'chuyen-doi-tien-te',
    name: 'Tiếng Việt',
    ogLocale: 'vi_VN',
    appleL: 'vi',
  },
]

/** The locale whose pages live at the site root and answer x-default. */
const DEFAULT_LOCALE = 'en'

for (const locale of WEB_LOCALES) {
  locale.apiLang = locale.fastlane.replace('-', '_')
}

const BY_CODE = Object.fromEntries(WEB_LOCALES.map(l => [l.code, l]))

/** URL path (absolute, trailing slash) of a currency-pair page. */
function pairPath(locale, base, quote) {
  const slug = `${locale.slug}-${base.toLowerCase()}-${quote.toLowerCase()}`
  return locale.code === DEFAULT_LOCALE ? `/${slug}/` : `/${locale.code}/${slug}/`
}

/** URL path of the hub page listing every pair of a locale. */
function hubPath(locale) {
  return locale.code === DEFAULT_LOCALE ? `/${locale.slug}/` : `/${locale.code}/${locale.slug}/`
}

// --------------------------------------------------------------------------
// 5. PAIRS
// --------------------------------------------------------------------------

/**
 * Which currency pairs get a landing page, per web locale.
 *
 * The lists are not a cartesian product: each one is the set of pairs the
 * matching Play Store listing already targets for that market, in the direction
 * people actually type the query. That is why the German list is EUR-centric
 * and cross-border, the Arabic list is Gulf-remittance-centric, and the
 * Vietnamese list is inbound-remittance-centric — they answer different
 * questions, which is also what keeps the pages from being translations of one
 * another.
 *
 * Order matters: it is the display order on the locale hub.
 */
const PAIRS_BY_LOCALE = {
  en: [
    'usd-eur', 'usd-mxn', 'usd-inr', 'usd-gbp', 'usd-cad', 'usd-jpy',
    'usd-php', 'usd-aud', 'usd-vnd', 'usd-krw', 'usd-cny', 'eur-usd',
  ],
  fr: [
    'eur-dzd', 'eur-mad', 'eur-tnd', 'eur-chf', 'eur-usd', 'eur-gbp',
    'eur-xof', 'eur-xaf', 'eur-cad', 'eur-jpy', 'eur-thb', 'usd-eur',
  ],
  es: [
    'eur-usd', 'usd-mxn', 'eur-mad', 'eur-cop', 'eur-gbp', 'eur-chf',
    'eur-dop', 'eur-pen', 'eur-ars', 'eur-mxn', 'eur-bob', 'usd-eur',
  ],
  de: [
    'eur-chf', 'eur-usd', 'eur-try', 'eur-pln', 'eur-uah', 'eur-gbp',
    'eur-czk', 'eur-huf', 'eur-dkk', 'eur-sek', 'eur-thb', 'usd-eur',
  ],
  it: [
    'eur-chf', 'eur-usd', 'eur-ron', 'eur-gbp', 'eur-uah', 'eur-mad',
    'eur-egp', 'eur-php', 'eur-try', 'eur-tnd', 'eur-aed', 'usd-eur',
  ],
  pt: [
    'usd-brl', 'eur-brl', 'gbp-brl', 'ars-brl', 'cad-brl', 'jpy-brl',
    'aud-brl', 'chf-brl', 'brl-usd', 'brl-eur', 'eur-usd', 'usd-eur',
  ],
  tr: [
    'usd-try', 'eur-try', 'gbp-try', 'chf-try', 'sar-try', 'aed-try',
    'rub-try', 'jpy-try', 'cad-try', 'aud-try', 'qar-try', 'try-usd',
  ],
  pl: [
    'eur-pln', 'chf-pln', 'usd-pln', 'gbp-pln', 'uah-pln', 'nok-pln',
    'czk-pln', 'sek-pln', 'dkk-pln', 'huf-pln', 'pln-eur', 'pln-gbp',
  ],
  ru: [
    'usd-rub', 'eur-rub', 'cny-rub', 'try-rub', 'aed-rub', 'thb-rub',
    'gbp-rub', 'chf-rub', 'jpy-rub', 'krw-rub', 'rub-usd', 'rub-eur',
  ],
  ja: [
    'usd-jpy', 'krw-jpy', 'eur-jpy', 'twd-jpy', 'thb-jpy', 'cny-jpy',
    'gbp-jpy', 'vnd-jpy', 'php-jpy', 'aud-jpy', 'hkd-jpy', 'sgd-jpy',
  ],
  ko: [
    'usd-krw', 'jpy-krw', 'eur-krw', 'vnd-krw', 'cny-krw', 'thb-krw',
    'twd-krw', 'php-krw', 'gbp-krw', 'aud-krw', 'hkd-krw', 'sgd-krw',
  ],
  zh: [
    'usd-cny', 'jpy-cny', 'hkd-cny', 'krw-cny', 'eur-cny', 'twd-cny',
    'thb-cny', 'gbp-cny', 'aud-cny', 'sgd-cny', 'cad-cny', 'myr-cny',
  ],
  hi: [
    'usd-inr', 'aed-inr', 'sar-inr', 'gbp-inr', 'eur-inr', 'cad-inr',
    'aud-inr', 'sgd-inr', 'kwd-inr', 'qar-inr', 'myr-inr', 'npr-inr',
  ],
  ar: [
    'usd-egp', 'usd-sar', 'usd-aed', 'sar-egp', 'aed-inr', 'aed-egp',
    'sar-inr', 'usd-mad', 'eur-mad', 'usd-dzd', 'eur-tnd', 'usd-kwd',
  ],
  vi: [
    'usd-vnd', 'krw-vnd', 'jpy-vnd', 'cny-vnd', 'twd-vnd', 'eur-vnd',
    'thb-vnd', 'sgd-vnd', 'aud-vnd', 'myr-vnd', 'cad-vnd', 'gbp-vnd',
  ],
}

/** 'eur-dzd' → { base: 'EUR', quote: 'DZD' } */
function splitPair(slug) {
  const [base, quote] = slug.split('-')
  return { base: base.toUpperCase(), quote: quote.toUpperCase() }
}

/**
 * Related pairs shown at the bottom of a page.
 *
 * Walks the locale's list as a ring starting after this pair, rather than
 * taking the first N matches. Taking the first N gives every page the same
 * handful of links and leaves the tail of the list with one inbound link each;
 * the ring gives every pair the same number of inbound links, which is what
 * spreads internal PageRank evenly and keeps nothing near-orphaned.
 */
function relatedPairs(slug, localeCode, limit = 6) {
  const all = PAIRS_BY_LOCALE[localeCode] || []
  const start = all.indexOf(slug)
  if (start === -1) return []

  const { base, quote } = splitPair(slug)
  const shares = other => {
    const o = splitPair(other)
    return o.base === base || o.quote === quote || o.base === quote || o.quote === base
  }

  const ring = []
  for (let step = 1; step < all.length; step++) ring.push(all[(start + step) % all.length])

  const related = ring.filter(shares).slice(0, limit)
  // A pair that shares nothing with its neighbours still needs siblings.
  return related.length ? related : ring.slice(0, limit)
}

/** Every distinct pair slug across every locale. */
function allPairSlugs() {
  return [...new Set(Object.values(PAIRS_BY_LOCALE).flat())].sort()
}

// --------------------------------------------------------------------------
// 6. TEXTSTATS
// --------------------------------------------------------------------------

/**
 * Text measurement shared by the validator and the per-locale checker.
 *
 * Splitting on whitespace is wrong for Japanese and Chinese: those scripts do
 * not delimit words, so a naive tokenizer returns a handful of sentence-sized
 * chunks and every downstream number — word count, n-gram overlap — becomes
 * meaningless. Detect the script and count characters instead.
 */

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/u

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<head>[\s\S]*?<\/head>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&[a-z]+;|&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** True when the text is dense enough in CJK that word splitting breaks down. */
function isCjk(text) {
  const letters = text.match(/\p{L}/gu)
  if (!letters || !letters.length) return false
  const cjk = text.match(new RegExp(CJK, 'gu'))
  return Boolean(cjk) && cjk.length / letters.length > 0.2
}

/**
 * Tokens for counting and for n-grams. Alphabetic scripts give words; CJK
 * gives individual characters, which is how CJK search engines segment too.
 */
function tokenize(text) {
  if (isCjk(text)) return [...text.replace(/[^\p{L}\p{N}]/gu, '')]
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/**
 * Minimum body length for a pair page. A CJK character carries roughly twice
 * the information of a Latin one, so the character threshold is not the word
 * threshold — it is calibrated to about the same amount of actual content.
 */
function minimumLength(text) {
  return isCjk(text) ? 700 : 320
}

/** n-gram width: 3 words, or 5 characters for CJK. */
function ngramWidth(text) {
  return isCjk(text) ? 5 : 3
}

function ngrams(tokens, n) {
  const set = new Set()
  for (let i = 0; i + n <= tokens.length; i++) set.add(tokens.slice(i, i + n).join('\\u0000'))
  return set
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const x of a) if (b.has(x)) shared++
  return shared / (a.size + b.size - shared)
}

/** Everything a caller needs about one page's body text, in one pass. */
function measure(html) {
  const text = visibleText(html)
  const tokens = tokenize(text)
  return {
    text,
    tokens,
    length: tokens.length,
    cjk: isCjk(text),
    minimum: minimumLength(text),
    grams: ngrams(tokens, ngramWidth(text)),
    unit: isCjk(text) ? 'characters' : 'words',
  }
}

// --------------------------------------------------------------------------
// 7. COPY — UI strings and page templates, one entry per language
// --------------------------------------------------------------------------

/**
 * English copy pack — the reference implementation of the copy contract.
 *
 * Every other locale in tools/copy/ exports this exact shape. Strings may use
 * these placeholders, which the generator substitutes:
 *
 *   {{app}}          Currency Converter & Exchange   (never translated)
 *   {{base}} {{quote}}             ISO 4217 codes, e.g. EUR / DZD
 *   {{baseName}} {{quoteName}}     localized currency names (CLDR)
 *   {{baseSym}} {{quoteSym}}       localized symbols
 *   {{baseCountry}} {{quoteCountry}}  localized issuing country/region
 *   {{baseBank}} {{quoteBank}}     issuing central bank (English proper noun)
 *   {{baseMinor}} {{quoteMinor}}   ISO 4217 minor-unit exponent
 *   {{provider}}                   name of the reference-rate provider
 *   {{pegAgainst}} {{pegSince}}          peg facts, peg templates only
 *
 * Writing rules these strings must respect (they are what makes the pages
 * rank and get quoted rather than read as templated filler):
 *   - Answer first. The lead's first sentence is a complete answer in ≤ 30 words.
 *   - Never "the app", "our converter", "it" — always {{app}}. Chunk retrievers
 *     lose anaphora, so every claim must name its subject.
 *   - Spell out "euro (EUR)" at least once; retrieval keys on names, not codes.
 *   - Hard numbers over adjectives. Never "the best converter".
 *   - Never state an exchange rate. Rates are fetched client-side at runtime.
 */

const COPY = {

  en: {
  // This file defines the contract: check-copy.mjs requires every other locale
  // to have exactly these keys, so a key that the renderer does not read costs
  // fifteen translations and buys nothing. Keep it in step with render.mjs.
  ui: {
    home: 'Home',
    hubBreadcrumb: 'Currency converter',
    otherLanguages: 'This page in other languages',
    relatedPairs: 'Related currency pairs',
    allPairs: 'All currency pairs',
    getTheApp: 'Get {{app}}',
    playBadge: '{{app}} on Google Play',
    appleBadge: '{{app}} on the App Store',
    screenshotsAlt: '{{app}} screen: ',
    screenHome: 'Converter home screen',
    screenChart: 'Historical exchange rate chart',
    screenSelect: 'Currency picker with search',
    factsHeading: 'The two currencies, side by side',
    factCode: 'ISO 4217 code',
    factSymbol: 'Symbol',
    factMinor: 'Minor unit (ISO 4217 exponent)',
    factBank: 'Issuing central bank',
    factRegion: 'Issued for',
    howToHeading: 'How to convert {{base}} to {{quote}} in {{app}}',
    faqHeading: 'Questions about {{base}} to {{quote}}',
    author: 'Published by Julien Millau, independent Android and iOS developer.',
    disclaimer:
      'Reference information only. Not financial advice, and not a quote for any transaction.',
    privacy: 'Privacy policy',
    terms: 'Terms of use',
    contact: 'Contact',
    currencyBasket: 'a basket of currencies',
  },

  /** ≤ 60 Latin chars / ≤ 30 full-width units. No rate, no brand suffix. */
  meta: {
    titlePair: '{{base}} to {{quote}} Converter – Rate & Offline App',
    descPair:
      '{{base}} to {{quote}}: what each currency is, who issues it, and what moves the rate. Converted offline by {{app}}, free on Android and iOS.',
    titleHub: 'Currency Converter App – 180+ Currencies, Offline',
    descHub:
      'Convert 180+ world currencies and 20+ cryptocurrencies, online or offline, with charts from one day to five years. Free on Android and iOS, no account.',
  },

  pair: {
    h1: 'Convert {{base}} to {{quote}}',

    /** Answer-first. First sentence ≤ 30 words, self-contained when quoted. */
    lead:
      'To convert {{baseName}} ({{base}}) into {{quoteName}} ({{quote}}), use {{app}} — a free Android and iOS app that keeps working offline from its last saved rates. '
      + 'This page is the reference for the pair itself: what each currency is, which central bank issues it, and what actually moves the rate between them.',

    factsIntro: 'Durable facts about each side of the pair — these change on a scale of years, unlike the rate.',

    pegBlock:
      '{{quoteName}} ({{quote}}) is not a floating currency against {{pegAgainst}}: it has been pegged since {{pegSince}}. '
      + 'The {{base}}/{{quote}} reference rate therefore barely moves, and a chart of it is close to a flat line. '
      + 'What does change is what you actually receive: banks, card networks and exchange bureaux add their own margin on top of the peg, so two providers quoting "the official rate" can still hand you different amounts.',

    /**
     * Used when one leg is pegged to a THIRD currency — 18 of these pages.
     * Saying "both currencies float" there would simply be false.
     */
    anchoredBlock:
      '{{pegName}} ({{pegCode}}) is pegged to {{pegAnchorName}}, not to {{floatName}}. '
      + 'The {{base}}/{{quote}} rate therefore moves almost entirely through the {{floatCode}} side: when this pair changes, it is {{floatName}} that moved. '
      + 'A chart of {{base}}/{{quote}} is in effect a chart of {{floatCode}} against {{pegAnchorName}}, and over short periods the margin a bank or bureau adds is a larger share of the cost than the rate itself.',

    floatBlock:
      'Both currencies float, so the {{base}}/{{quote}} rate is set by the market rather than fixed — mainly by the interest-rate decisions of {{baseBank}} and {{quoteBank}}. '
      + 'That is why no static page can print a rate and stay correct.',

    howto: [
      'Enter the {{base}} amount.',
      'Pick {{quoteName}} ({{quote}}) — search by country, currency name or ISO code.',
      'Tap the converted {{quote}} figure to copy or share it.',
      'Pin {{base}}/{{quote}} to your favourites for one-tap access.',
    ],

    /**
     * Shown on every page: the two questions nobody else answers honestly.
     * Answers must match the FAQPage JSON-LD verbatim, so they live here once.
     */
    faqAlways: [
      {
        q: 'Where does {{app}} get its {{base}}/{{quote}} rate?',
        a: 'From financial data providers, refreshed several times a day whenever the device has a connection. {{app}} timestamps every update, so you can always see how old the figure on screen is.',
      },
      {
        q: 'Does that rate include my bank’s fees?',
        a: 'No. {{app}} shows an interbank reference rate. Banks, card networks and exchange bureaux add their own margin on top, so the {{quote}} you actually receive for your {{base}} will be less.',
      },
    ],

    /** One of these is shown per page, chosen deterministically from the pair. */
    faqRotating: [
      {
        q: 'Does {{app}} convert {{base}} to {{quote}} without internet?',
        a: 'Yes. {{app}} stores the last rates it downloaded on the device and keeps converting with no connection, showing the date they were fetched.',
      },
      {
        q: 'How often does {{app}} update the {{base}}/{{quote}} rate?',
        a: 'Several times a day, from financial data providers, each time the device has a connection. The app shows when the figure was last refreshed.',
      },
      {
        q: 'Is {{app}} free?',
        a: 'Yes, free to install on Android and iOS, with no account and no sign-in. The free edition is ad-supported; the Pro edition removes the ads.',
      },
    ],

    relatedIntro: 'Other {{base}} and {{quote}} conversions covered on this site:',
  },

  hub: {
    h1: 'Currency converter app',
    lead:
      '{{app}} is a free currency converter for Android and iOS that converts between 180+ world currencies and 20+ cryptocurrencies. '
      + 'It refreshes exchange rates several times a day, charts them from 1 day to 5 years, and keeps converting from the last saved rates when you have no connection. No account and no sign-in.',
    featuresHeading: 'What {{app}} does',
    features: [
      '180+ world currencies, searchable by country, currency name or ISO 4217 code',
      '20+ cryptocurrencies including Bitcoin (BTC) and Ethereum (ETH)',
      'Exchange rates refreshed several times a day from financial data providers',
      'Full offline conversion from the last saved rates, with the date they were fetched',
      'Historical charts from 1 day to 5 years',
      'Home-screen widget and a customisable favourites list',
      'Decimal precision you set yourself, and any result copied with a single tap',
      'No account and no sign-in — install and convert',
    ],
    pairsHeading: 'Currency pairs covered in English',
    pairsIntro:
      'Each page below explains one pair and lists the durable facts about both currencies.',
    editionsHeading: 'Which edition to install',
    editionFree: 'Android — free',
    editionPro: 'Android — Pro',
    editionIos: 'iOS',
    editionFreeNote: 'All conversion features, supported by ads.',
    editionProNote: 'The same app without ads.',
    editionIosNote: 'iPhone and iPad, with widget support.',
    supportedHeading: 'Every currency {{app}} supports',
    // {{count}}, {{fiatCount}} and {{cryptoCount}} come from the app's own
    // catalogue, fetched by tools/fetch-app-currencies.mjs. They are empty
    // until that has been run, and this section is not rendered before then.
    supportedIntro:
      'All {{count}} of them, read from the app’s own catalogue rather than rounded up for a store listing: {{fiatCount}} national currencies and {{cryptoCount}} cryptocurrencies. Hover a code to see its name.',
    languagesHeading: 'Currency pages in other languages',
  },
},

  fr: {

  /**
   * Official names of the issuing central banks in this language. Only the ones
   * this locale's pairs actually use are listed; anything absent falls back to
   * the English name in tools/lib/currency-facts.mjs, which is correct for
   * institutions whose name is not normally translated.
   */
  banks: {
    EUR: "Banque centrale européenne",
    USD: "Réserve fédérale américaine",
    GBP: "Banque d’Angleterre",
    CHF: "Banque nationale suisse",
    CAD: "Banque du Canada",
    JPY: "Banque du Japon",
    THB: "Banque de Thaïlande",
    TND: "Banque centrale de Tunisie",
    DZD: "Banque d’Algérie",
    XOF: "Banque centrale des États de l’Afrique de l’Ouest (BCEAO)",
    XAF: "Banque des États de l’Afrique centrale (BEAC)",
  },
  /** Nom de la langue affiché dans le sélecteur des autres locales. */
  languageName: 'Français',

  ui: {
    home: 'Accueil',
    hubBreadcrumb: 'Convertisseur de devises',
    otherLanguages: 'Cette page dans d’autres langues',
    relatedPairs: 'Paires de devises liées',
    allPairs: 'Toutes les paires de devises',
    getTheApp: 'Installer {{app}}',
    playBadge: '{{app}} sur Google Play',
    appleBadge: '{{app}} sur l’App Store',
    screenshotsAlt: 'Capture d’écran de {{app}} : ',
    screenHome: 'Écran principal du convertisseur',
    screenChart: 'Courbe historique du taux de change',
    screenSelect: 'Sélecteur de devise avec recherche',
    factsHeading: 'Les deux devises, côte à côte',
    factCode: 'Code ISO 4217',
    factSymbol: 'Symbole',
    factMinor: 'Sous-unité (exposant ISO 4217)',
    factBank: 'Banque centrale émettrice',
    factRegion: 'Émise pour',
    howToHeading: 'Convertir {{base}} en {{quote}} avec {{app}}',
    faqHeading: 'Questions sur la conversion {{base}} vers {{quote}}',
    author: 'Publié par Julien Millau, développeur indépendant Android et iOS.',
    disclaimer:
      'Informations de référence, communiquées à titre indicatif. Ni conseil financier, ni proposition contractuelle pour une opération.',
    privacy: 'Politique de confidentialité',
    terms: 'Conditions d’utilisation',
    contact: 'Contact',
    currencyBasket: 'un panier de devises',
  },

  /** ≤ 60 caractères pour les titres, ≤ 158 pour les descriptions. */
  meta: {
    titlePair: 'Convertir {{base}} en {{quote}} – taux et appli hors ligne',
    descPair:
      '{{base}} et {{quote}} : chaque monnaie, son émetteur, et ce qui fait bouger le taux. {{app}} convertit hors ligne, gratuit sur Android et iOS.',
    titleHub: 'Convertisseur de devises – 180+ monnaies, hors ligne',
    descHub:
      'Convertissez plus de 180 monnaies et 20+ cryptomonnaies, en ligne ou sans réseau, avec des courbes d’un jour à cinq ans. Gratuit sur Android et iOS.',
  },

  pair: {
    h1: 'Convertir {{base}} en {{quote}}',

    /**
     * Repli quand une paire n’a pas de bloc corridor rédigé.
     *
     * La page ne convertit rien : elle explique la paire et présente
     * l’application qui la convertit. Les noms de monnaie viennent de CLDR au
     * singulier et changent de genre d’une page à l’autre : ils sont donc
     * placés après « respectivement », un emplacement qui ne demande ni article
     * ni accord.
     */
    lead:
      'Pour convertir un montant de {{base}} en {{quote}}, utilisez {{app}}, une application gratuite pour Android et iOS qui convertit aussi hors réseau, à partir des derniers taux enregistrés. '
      + 'Cette page, elle, sert de référence sur la paire elle-même : ce que sont ces deux monnaies — respectivement {{baseName}} et {{quoteName}} —, quelle banque centrale émet chacune, et ce qui déplace vraiment le taux de l’une à l’autre.',

    factsIntro: 'Les repères stables de chaque devise : ils évoluent à l’échelle des années, contrairement au taux.',

    /**
     * Une parité bilatérale : la monnaie cotée est arrimée à l’autre membre de
     * la paire. Rédigé avec les seuls codes ISO — « Le {{quoteName}} » imposait
     * un genre que le nom CLDR ne garantit pas, et « avec {{pegAgainst}} »
     * réclamait un article qui varie lui aussi.
     */
    pegBlock:
      'Ce ne sont pas les échanges qui relient {{base}} et {{quote}}, mais une parité fixe, en place depuis {{pegSince}}, un rapport que le marché ne déplace pas. '
      + 'Le taux de référence {{base}}/{{quote}} ne bouge donc pour ainsi dire jamais, et sa courbe ressemble à une ligne droite. '
      + 'Ce qui varie, c’est la somme réellement remise : banques, opérateurs de transfert et bureaux de change appliquent leur marge par-dessus la parité, si bien que deux prestataires annonçant « le taux officiel » ne versent pas la même chose.',

    /**
     * Employé quand une seule des deux monnaies est arrimée, et à une devise
     * tierce : écrire « les deux monnaies flottent » y serait faux.
     */
    anchoredBlock:
      '{{pegCode}} ne flotte pas : cette monnaie est arrimée à une référence extérieure à la paire ({{pegAnchorName}}), pas à {{floatCode}}. '
      + 'Le taux {{base}}/{{quote}} ne bouge donc que par le côté {{floatCode}} : quand ce taux change, c’est ce côté-là qui a bougé. '
      + 'La courbe {{base}}/{{quote}} revient à celle de {{floatCode}} face à cette référence ; sur quelques jours, la marge d’une banque ou d’un bureau de change pèse plus lourd dans la note finale que le taux lui-même.',

    /**
     * Les deux noms de banque centrale arrivent après le deux-points : certains
     * prennent l’article (« la Banque du Japon »), d’autres non (« Bank
     * Al-Maghrib »), et cette place-là n’en réclame aucun.
     */
    floatBlock:
      'Aucune parité fixe ne relie {{base}} et {{quote}} : le taux {{base}}/{{quote}} évolue jour après jour, sous l’influence des décisions de taux d’intérêt de deux banques centrales — {{baseBank}} d’un côté, {{quoteBank}} de l’autre. '
      + 'C’est pour cette raison qu’aucune page figée ne peut afficher un taux et rester exacte.',

    howto: [
      'Saisissez le montant en {{base}}.',
      'Choisissez la devise d’arrivée : {{quoteName}}, code {{quote}}. La recherche accepte le nom du pays, celui de la monnaie ou le code ISO.',
      'Appuyez sur le résultat en {{quote}} pour le copier ou le partager.',
      'Épinglez la paire {{base}}/{{quote}} dans vos favoris pour la retrouver en un appui.',
    ],

    offline:
      '{{app}} conserve sur l’appareil les derniers taux téléchargés : la conversion {{base}} vers {{quote}} continue donc de fonctionner en avion, dans le métro ou à l’étranger avec les données coupées. Chaque taux enregistré porte sa date de récupération, vous savez toujours de quand date le chiffre affiché.',

    /** Affichées sur chaque page ; le texte doit coller au JSON-LD FAQPage. */
    faqAlways: [
      {
        q: 'D’où vient le taux {{base}}/{{quote}} utilisé par {{app}} ?',
        a: 'De fournisseurs de données financières, rafraîchi plusieurs fois par jour dès que l’appareil capte du réseau. {{app}} horodate chaque mise à jour : vous savez toujours de quand date le chiffre que vous avez sous les yeux.',
      },
      {
        q: 'Ce taux comprend-il les frais de ma banque ?',
        a: 'Non. {{app}} affiche un taux de référence interbancaire. Banques, réseaux de cartes et bureaux de change ajoutent leur propre marge par-dessus : la somme en {{quote}} réellement reçue pour un montant donné en {{base}} sera donc inférieure.',
      },
    ],

    /** Une seule est retenue par page, choisie de façon déterministe. */
    faqRotating: [
      {
        q: '{{app}} convertit-il {{base}} en {{quote}} sans connexion ?',
        a: 'Oui. {{app}} conserve sur l’appareil les derniers taux téléchargés et continue de convertir réseau coupé, en indiquant la date à laquelle ils ont été récupérés.',
      },
      {
        q: 'À quelle fréquence {{app}} actualise-t-il le taux {{base}}/{{quote}} ?',
        a: 'Plusieurs fois par jour, auprès de fournisseurs de données financières, chaque fois que l’appareil dispose d’une connexion. L’application indique quand le chiffre a été rafraîchi pour la dernière fois.',
      },
      {
        q: '{{app}} est-il gratuit ?',
        a: 'Oui, gratuit à l’installation sur Android et iOS, sans compte ni inscription. La version gratuite est financée par la publicité, la version Pro la supprime.',
      },
    ],

    relatedIntro: 'Les autres conversions {{base}} et {{quote}} traitées sur ce site :',
  },

  hub: {
    h1: 'Convertisseur de devises',
    lead:
      '{{app}} est un convertisseur de devises gratuit pour Android et iOS, capable de passer d’une monnaie à l’autre parmi plus de 180 devises mondiales et une vingtaine de cryptomonnaies. '
      + 'Les taux sont rafraîchis plusieurs fois par jour, tracés de la journée écoulée aux cinq dernières années, et la conversion continue à partir des derniers taux enregistrés lorsque le réseau manque. Ni compte, ni inscription.',
    featuresHeading: 'Ce que fait {{app}}',
    features: [
      'Plus de 180 devises mondiales, cherchables par pays, par nom de monnaie ou par code ISO 4217',
      'Une vingtaine de cryptomonnaies, dont le bitcoin (BTC) et l’ether (ETH)',
      'Taux rafraîchis plusieurs fois par jour auprès de fournisseurs de données financières',
      'Conversion complète sans réseau, à partir des derniers taux enregistrés et de leur date',
      'Courbes historiques de la journée écoulée aux cinq dernières années',
      'Widget d’écran d’accueil et liste de favoris que vous ordonnez vous-même',
      'Nombre de décimales réglable, résultat copié d’un seul appui',
      'Aucun compte, aucune inscription : on installe et on convertit',
    ],
    pairsHeading: 'Paires de devises couvertes en français',
    pairsIntro:
      'Chaque page ci-dessous traite une paire et rassemble les repères durables des deux monnaies.',
    editionsHeading: 'Quelle version installer',
    editionFree: 'Android — gratuite',
    editionPro: 'Android — Pro',
    editionIos: 'iOS',
    editionFreeNote: 'Toutes les fonctions de conversion, financées par la publicité.',
    editionProNote: 'La même application, sans publicité.',
    editionIosNote: 'iPhone et iPad, widget compris.',
    supportedHeading: 'Toutes les devises gérées par {{app}}',
    supportedIntro:
      'La liste ci-dessous est lue dans le catalogue de l’application : c’est donc ce qu’elle embarque réellement, et non un chiffre marketing arrondi. Survolez un code pour lire le nom de la monnaie.',
    languagesHeading: 'Pages de conversion dans d’autres langues',
  },
},

  es: {

  /**
   * Official names of the issuing central banks in this language. Only the ones
   * this locale's pairs actually use are listed; anything absent falls back to
   * the English name in tools/lib/currency-facts.mjs, which is correct for
   * institutions whose name is not normally translated.
   */
  banks: {
    EUR: "Banco Central Europeo",
    USD: "Sistema de la Reserva Federal",
    GBP: "Banco de Inglaterra",
    CHF: "Banco Nacional Suizo",
  },
  /** Nombre del idioma tal como lo ven las demás ediciones. */
  languageName: 'Español',

  ui: {
    home: 'Inicio',
    hubBreadcrumb: 'Conversor de divisas',
    convert: 'Convertir',
    source: 'Fuente',
    otherLanguages: 'Esta página en otros idiomas',
    relatedPairs: 'Pares de divisas relacionados',
    allPairs: 'Todos los pares de divisas',
    getTheApp: 'Descarga {{app}}',
    playBadge: '{{app}} en Google Play',
    appleBadge: '{{app}} en la App Store',
    screenshotsAlt: 'Pantalla de {{app}}: ',
    screenHome: 'Pantalla principal del conversor',
    screenChart: 'Gráfico histórico del tipo de cambio',
    screenSelect: 'Selector de moneda con buscador',
    factsHeading: 'Las dos monedas, una al lado de la otra',
    factCode: 'Código ISO 4217',
    factSymbol: 'Símbolo',
    factMinor: 'Unidad menor (exponente ISO 4217)',
    factBank: 'Banco central emisor',
    factRegion: 'Emitida para',
    howToHeading: 'Cómo convertir {{base}} a {{quote}} en {{app}}',
    faqHeading: 'Preguntas sobre {{base}} y {{quote}}',
    author: 'Publicado por Julien Millau, desarrollador independiente de Android e iOS.',
    disclaimer:
      'Información de referencia, solo a título informativo. No es asesoramiento financiero ni una cotización en firme para ninguna operación.',
    privacy: 'Política de privacidad',
    terms: 'Condiciones de uso',
    contact: 'Contacto',
    currencyBasket: 'una cesta de divisas',
  },

  /** ≤ 60 unidades SERP en el título, ≤ 158 en la descripción. Sin firma. */
  meta: {
    titlePair: 'Convertir {{base}} a {{quote}}: cambio y app sin conexión',
    descPair:
      'De {{base}} a {{quote}}: qué es cada moneda, quién la emite y qué mueve su cotización. Lo convierte {{app}}, gratis en Android e iOS y sin red.',
    titleHub: 'Conversor de divisas: 180+ monedas, también sin red',
    descHub:
      'Convierte más de 180 divisas y más de 20 criptomonedas, con o sin cobertura, y con gráficos de un día a cinco años. Gratis en Android e iOS, sin cuenta.',
  },

  pair: {
    h1: 'Convertir {{base}} a {{quote}}',

    /** Respuesta primero. Primera frase ≤ 30 palabras y autosuficiente. */
    lead:
      '{{app}} convierte {{baseName}} ({{base}}) en {{quoteName}} ({{quote}}): es gratis, funciona en Android e iOS y sigue calculando sin conexión con las últimas tasas guardadas. '
      + 'Esta página es la referencia del par en sí: qué es cada moneda, qué banco central la emite y qué mueve de verdad la cotización entre las dos.',

    factsIntro: 'Datos duraderos de cada lado del par: se miden en años, al contrario que la cotización.',

    pegBlock:
      'Este par no flota: {{quote}} ({{quoteName}}) mantiene desde {{pegSince}} un tipo fijo, con una sola referencia detrás: {{pegAgainst}}. '
      + 'El tipo {{base}}/{{quote}} apenas se mueve por eso, y dibujado en un gráfico se parece a una línea recta. '
      + 'Lo que sí cambia es lo que acabas recibiendo: bancos, redes de tarjetas y oficinas de cambio suman su margen sobre el anclaje, así que dos proveedores que dicen aplicar «el tipo oficial» pueden entregarte cantidades distintas.',

    /**
     * Se usa cuando una de las dos monedas está anclada a una TERCERA divisa.
     * Ahí decir que las dos flotan sería sencillamente falso.
     */
    anchoredBlock:
      '{{pegCode}} ({{pegName}}) no se mueve libremente, pero su ancla no es la otra mitad del par, sino una tercera divisa: {{pegAnchorName}}. '
      + 'El tipo {{base}}/{{quote}} se mueve por eso casi solo por el lado de {{floatCode}}: cuando este par cambia, lo que se ha movido es la moneda que sí flota, {{floatCode}}. '
      + 'Un gráfico de {{base}}/{{quote}} es en realidad el de {{floatCode}} contra esa misma referencia, y en plazos cortos el margen que añaden bancos y oficinas de cambio pesa más en el coste que la propia cotización.',

    floatBlock:
      'En este par no hay anclaje: ninguna de las dos monedas está fijada a la otra, así que el tipo {{base}}/{{quote}} lo marcan el mercado y, sobre todo, las decisiones de tipos de interés de sus dos bancos centrales emisores: {{baseBank}} y {{quoteBank}}. '
      + 'Por eso ninguna página estática puede imprimir una cifra y seguir teniendo razón mañana.',

    howto: [
      'Escribe la cantidad en {{base}}.',
      'Elige la moneda de destino, {{quote}} ({{quoteName}}), buscándola por su nombre, por el del país o por su código ISO 4217.',
      'Toca la cifra convertida en {{quote}} para copiarla o compartirla.',
      'Ancla {{base}}/{{quote}} en favoritos y tenlo a un toque la próxima vez.',
    ],

    offline:
      '{{app}} guarda en el dispositivo las últimas tasas que descargó, así que la conversión de {{base}} a {{quote}} sigue disponible en un avión, en el metro o en el extranjero con los datos apagados. Cada tasa almacenada lleva la fecha en que se obtuvo, para que sepas siempre cuánto ha envejecido la cifra.',

    /**
     * Aparecen en todas las páginas: las dos preguntas que casi nadie responde
     * con honestidad. El texto debe coincidir con el JSON-LD, por eso vive aquí.
     */
    faqAlways: [
      {
        q: '¿De dónde saca {{app}} su tipo {{base}}/{{quote}}?',
        a: 'De proveedores de datos financieros, con varios refrescos al día siempre que el dispositivo tenga conexión. {{app}} marca con fecha y hora cada actualización, así que se ve en todo momento cuánto ha envejecido la cifra en pantalla.',
      },
      {
        q: '¿Ese tipo incluye las comisiones de mi banco?',
        a: 'No. {{app}} muestra una referencia interbancaria. Bancos, redes de tarjetas y oficinas de cambio añaden encima su propio margen, así que por cada {{base}} acabarás recibiendo menos {{quote}} de los que indica esa referencia.',
      },
    ],

    /** Se muestra una por página, elegida de forma determinista según el par. */
    faqRotating: [
      {
        q: '¿Convierte {{app}} de {{base}} a {{quote}} sin internet?',
        a: 'Sí. {{app}} guarda en el dispositivo las últimas tasas que descargó y sigue convirtiendo sin ninguna conexión, indicando la fecha en que se obtuvieron.',
      },
      {
        q: '¿Cada cuánto actualiza {{app}} el tipo {{base}}/{{quote}}?',
        a: 'Varias veces al día, a partir de proveedores de datos financieros, cada vez que el dispositivo tiene conexión. {{app}} indica cuándo se refrescó la cifra por última vez.',
      },
      {
        q: '¿{{app}} es gratis?',
        a: 'Sí, se instala gratis en Android y en iOS, sin cuenta y sin ningún registro previo. La edición gratuita se sostiene con publicidad; la edición Pro la elimina.',
      },
    ],

    relatedIntro: 'Otras conversiones con {{base}} y {{quote}} publicadas en este sitio:',
  },

  hub: {
    h1: 'Conversor de divisas para móvil',
    lead:
      '{{app}} es un conversor de divisas gratuito para Android e iOS que calcula entre más de 180 monedas del mundo y más de 20 criptomonedas. '
      + 'Refresca las tasas varias veces cada jornada, las dibuja desde un día hasta cinco años atrás y sigue convirtiendo con la última descarga cuando te quedas sin cobertura. Sin cuenta y sin registro previo.',
    featuresHeading: 'Qué hace {{app}}',
    features: [
      'Más de 180 monedas de curso legal, del euro y el dólar al dírham, el peso colombiano o la corona sueca',
      'Más de 20 criptomonedas, entre ellas Bitcoin (BTC) y Ethereum (ETH)',
      'Tasas que se renuevan varias veces cada jornada a partir de proveedores de datos financieros',
      'Conversión completa sin cobertura, con la última descarga y la fecha en que se obtuvo',
      'Gráficos del tipo de cambio desde un día hasta cinco años atrás',
      'Widget para la pantalla de inicio y una lista de favoritos que ordenas tú',
      'Precisión decimal configurable y copia del resultado con un solo toque',
      'Sin cuenta ni registro: se instala y se empieza a convertir',
    ],
    pairsHeading: 'Pares de divisas publicados en español',
    pairsIntro:
      'Cada página explica un par y reúne los datos duraderos de las dos monedas.',
    editionsHeading: 'Qué edición instalar',
    editionFree: 'Android — gratis',
    editionPro: 'Android — Pro',
    editionIos: 'iOS',
    editionFreeNote: 'Todas las funciones de conversión, con publicidad.',
    editionProNote: 'La misma aplicación sin anuncios.',
    editionIosNote: 'iPhone y iPad, con soporte de widget.',
    supportedHeading: 'Todas las monedas que admite {{app}}',
    supportedIntro:
      'La lista sale del propio catálogo de la aplicación, así que es lo que realmente lleva dentro y no una cifra redondeada de folleto. Pasa el cursor por un código para ver el nombre de la moneda.',
    languagesHeading: 'Páginas de divisas en otros idiomas',
  },
},

  de: {

  /**
   * Official names of the issuing central banks in this language. Only the ones
   * this locale's pairs actually use are listed; anything absent falls back to
   * the English name in tools/lib/currency-facts.mjs, which is correct for
   * institutions whose name is not normally translated.
   */
  banks: {
    EUR: "Europäische Zentralbank",
    CHF: "Schweizerische Nationalbank",
    USD: "US-Notenbank Federal Reserve",
    TRY: "Zentralbank der Republik Türkei",
    PLN: "Polnische Nationalbank",
    UAH: "Nationalbank der Ukraine",
    CZK: "Tschechische Nationalbank",
    HUF: "Ungarische Nationalbank",
    DKK: "Dänische Nationalbank",
    SEK: "Schwedische Reichsbank",
  },
  /** Sprachname, wie ihn die Sprachumschaltung anderer Sprachen anzeigt. */
  languageName: 'Deutsch',

  ui: {
    home: 'Startseite',
    hubBreadcrumb: 'Währungsrechner',
    convert: 'Umrechnen',
    source: 'Quelle',
    otherLanguages: 'Diese Seite in anderen Sprachen',
    relatedPairs: 'Verwandte Währungspaare',
    allPairs: 'Alle Währungspaare',
    getTheApp: '{{app}} installieren',
    playBadge: '{{app}} bei Google Play',
    appleBadge: '{{app}} im App Store',
    screenshotsAlt: 'Bildschirm aus {{app}}: ',
    screenHome: 'Startbildschirm des Rechners',
    screenChart: 'Kursverlauf eines Wechselkurses',
    screenSelect: 'Währungsauswahl mit Suchfeld',
    factsHeading: 'Die beiden Währungen nebeneinander',
    factCode: 'ISO-4217-Code',
    factSymbol: 'Symbol',
    factMinor: 'Untereinheit (ISO-4217-Exponent)',
    factBank: 'Ausgebende Zentralbank',
    factRegion: 'Ausgegeben für',
    howToHeading: '{{base}} in {{quote}} umrechnen mit {{app}}',
    faqHeading: 'Fragen zu {{base}} und {{quote}}',
    author: 'Herausgegeben von Julien Millau, unabhängiger Android- und iOS-Entwickler.',
    disclaimer:
      'Angaben zur Orientierung, ausschließlich zur Information. Keine Finanzberatung und für eine Transaktion nicht verbindlich.',
    privacy: 'Datenschutzerklärung',
    terms: 'Nutzungsbedingungen',
    contact: 'Kontakt',
    currencyBasket: 'ein Währungskorb',
  },

  /** Titel ≤ 55 Zeichen, Beschreibung ≤ 158 — nach Einsetzen der Codes. */
  meta: {
    titlePair: '{{base}} in {{quote}} umrechnen – Kurs & Offline-App',
    descPair:
      '{{base}} und {{quote}}: was beide Währungen sind, wer sie ausgibt und was den Kurs bewegt. Umgerechnet wird in {{app}} – gratis und offline.',
    titleHub: 'Währungsrechner-App – 180+ Währungen, offline',
    descHub:
      'Über 180 Währungen und mehr als 20 Kryptowährungen umrechnen, mit oder ohne Internet, mit Kursverläufen bis fünf Jahre. Gratis für Android und iOS.',
  },

  pair: {
    h1: '{{base}} in {{quote}} umrechnen',

    /** Antwort zuerst; erster Satz ≤ 30 Wörter und für sich zitierbar. */
    lead:
      'Die Umrechnung von {{baseName}} ({{base}}) in {{quoteName}} ({{quote}}) übernimmt {{app}} – kostenlos für Android und iOS, ohne Verbindung mit den zuletzt gespeicherten Kursen. '
      + 'Diese Seite ist das Nachschlagewerk zum Paar selbst: was hinter beiden Währungen steht, welche Notenbank sie ausgibt und was den Kurs zwischen ihnen bewegt.',

    factsIntro: 'Beständige Angaben zu beiden Seiten des Paares – sie ändern sich im Rhythmus von Jahren, anders als der Kurs.',

    pegBlock:
      'Bei diesem Paar bewegt sich nur eine Seite frei. Die andere – {{quoteName}} ({{quote}}) – folgt seit {{pegSince}} einem festen Leitkurs gegenüber {{base}}, gesteuert von der ausgebenden Notenbank ({{quoteBank}}). '
      + 'Der Referenzkurs {{base}}/{{quote}} bewegt sich deshalb nur in winzigen Schritten, und ein Kursverlauf sieht fast aus wie eine gerade Linie. '
      + 'Was sich sehr wohl unterscheidet, ist der Betrag, der bei Ihnen ankommt: Banken, Kartensysteme und Wechselstuben legen ihre eigene Marge auf den Leitkurs, sodass zwei Anbieter mit demselben amtlichen Kurs verschieden viel auszahlen.',

    /**
     * Für Paare, bei denen eine Seite an eine DRITTE Währung gekoppelt ist.
     * „Beide Währungen schwanken frei“ wäre dort schlicht falsch.
     */
    anchoredBlock:
      'Eine Seite dieses Paares schwankt nicht frei: {{pegCode}} folgt einem festen Anker, und dieser Anker ist nicht {{floatCode}}, sondern {{pegAnchorName}}. '
      + 'Der Kurs {{base}}/{{quote}} bewegt sich deshalb fast ausschließlich über die Seite {{floatCode}}: Wenn sich dieses Paar ändert, hat sich {{floatCode}} bewegt. '
      + 'Ein Kursverlauf von {{base}}/{{quote}} ist im Grunde ein Kursverlauf von {{floatCode}} gegenüber diesem Anker, und auf kurze Sicht wiegt die Marge, die eine Bank oder Wechselstube aufschlägt, schwerer als die Bewegung des Kurses selbst.',

    floatBlock:
      'Beide Währungen schwanken frei: Der Kurs {{base}}/{{quote}} entsteht am Markt und steht nirgends fest. '
      + 'Am stärksten bewegen ihn die Zinsentscheidungen der beiden ausgebenden Notenbanken. Zuständig sind: {{baseBank}} für {{base}}, {{quoteBank}} für {{quote}}. '
      + 'Genau deshalb kann keine feste Seite eine Zahl abdrucken und dauerhaft richtig bleiben.',

    howto: [
      'Betrag in {{base}} eingeben.',
      '{{quoteName}} ({{quote}}) auswählen – suchbar nach Land, Währungsname oder ISO-Code.',
      'Auf das umgerechnete Ergebnis in {{quote}} tippen, um es zu kopieren oder zu teilen.',
      '{{base}}/{{quote}} als Favorit anheften und beim nächsten Mal mit einem Fingertipp öffnen.',
    ],

    offline:
      '{{app}} legt die zuletzt geladenen Wechselkurse auf dem Gerät ab. Die Umrechnung von {{base}} in {{quote}} funktioniert deshalb auch im Flugzeug, in der U-Bahn oder im Ausland mit abgeschaltetem Roaming. Zu jedem gespeicherten Kurs gehört das Datum des Abrufs, damit Sie wissen, wie alt die Zahl ist.',

    /**
     * Steht auf jeder Seite: die zwei Fragen, die sonst niemand ehrlich
     * beantwortet. Der Wortlaut wandert unverändert in das FAQPage-JSON-LD.
     */
    faqAlways: [
      {
        q: 'Woher bezieht {{app}} den Kurs {{base}}/{{quote}}?',
        a: 'Von Finanzdatenanbietern, mehrmals am Tag nachgeladen, sobald das Gerät eine Verbindung hat. {{app}} vermerkt zu jeder Aktualisierung den Zeitpunkt, sodass am Bildschirm ablesbar bleibt, wie alt die Zahl ist.',
      },
      {
        q: 'Sind die Gebühren meiner Bank in diesem Kurs enthalten?',
        a: 'Nein. {{app}} zeigt einen Interbanken-Referenzkurs. Banken, Kartensysteme und Wechselstuben legen ihre eigene Marge darauf; für einen Betrag in {{base}} kommt am Ende also weniger {{quote}} bei Ihnen an.',
      },
    ],

    /** Eine davon pro Seite, fest aus dem Währungspaar abgeleitet. */
    faqRotating: [
      {
        q: 'Rechnet {{app}} {{base}} in {{quote}} auch ohne Internet um?',
        a: 'Ja. {{app}} legt die zuletzt geladenen Kurse auf dem Gerät ab und rechnet ohne Verbindung weiter, samt Datum des Abrufs.',
      },
      {
        q: 'Wie oft aktualisiert {{app}} den Kurs {{base}}/{{quote}}?',
        a: 'Mehrmals am Tag, von Finanzdatenanbietern, jedes Mal wenn das Gerät online ist. Wann zuletzt neue Kurse ankamen, zeigt {{app}} an.',
      },
      {
        q: 'Ist {{app}} kostenlos?',
        a: 'Ja, die Installation unter Android und iOS kostet nichts, ohne Konto und ohne Anmeldung. Die Gratisfassung finanziert sich über Werbung, die Pro-Fassung kommt ohne aus.',
      },
    ],

    relatedIntro: 'Weitere Umrechnungen mit {{base}} und {{quote}} auf dieser Website:',
  },

  hub: {
    h1: 'Währungsrechner-App',
    lead:
      '{{app}} ist ein kostenloser Währungsrechner für Android und iOS, der zwischen mehr als 180 Weltwährungen und über 20 Kryptowährungen umrechnet. '
      + 'Neue Kurse kommen mehrmals am Tag, der Verlauf reicht von einem Tag bis fünf Jahre zurück, und ohne Verbindung rechnet {{app}} mit den zuletzt gespeicherten Kursen weiter. Kein Konto, keine Anmeldung.',
    featuresHeading: 'Was {{app}} kann',
    features: [
      'Mehr als 180 Weltwährungen, suchbar nach Land, Währungsname oder ISO-4217-Code',
      'Über 20 Kryptowährungen, darunter Bitcoin (BTC) und Ethereum (ETH)',
      'Kurse mehrmals am Tag von Finanzdatenanbietern nachgeladen',
      'Vollständige Umrechnung ohne Internet, samt Datum der zuletzt geladenen Kurse',
      'Kursverläufe von einem Tag bis zu fünf Jahren',
      'Widget für den Startbildschirm und eine frei sortierbare Favoritenliste',
      'Selbst gewählte Anzahl an Nachkommastellen, jedes Ergebnis mit einem Tipp kopiert',
      'Kein Konto, keine Anmeldung – installieren und umrechnen',
    ],
    pairsHeading: 'Währungspaare auf Deutsch',
    pairsIntro:
      'Jede Seite erklärt ein Paar und listet die beständigen Angaben zu beiden Währungen auf.',
    editionsHeading: 'Welche Fassung passt',
    editionFree: 'Android – gratis',
    editionPro: 'Android – Pro',
    editionIos: 'iOS',
    editionFreeNote: 'Alle Rechenfunktionen, finanziert über Werbung.',
    editionProNote: 'Dieselbe App, ohne Werbung.',
    editionIosNote: 'iPhone und iPad, mit Widget.',
    supportedHeading: 'Alle Währungen, die {{app}} kennt',
    supportedIntro:
      'Die folgende Liste stammt aus dem Katalog der App selbst und zeigt daher den tatsächlichen Umfang statt einer gerundeten Werbezahl. Zeigen Sie auf einen Code, um den Währungsnamen zu sehen.',
    languagesHeading: 'Währungsseiten in anderen Sprachen',
  },
},

  it: {

  /**
   * Official names of the issuing central banks in this language. Only the ones
   * this locale's pairs actually use are listed; anything absent falls back to
   * the English name in tools/lib/currency-facts.mjs, which is correct for
   * institutions whose name is not normally translated.
   */
  banks: {
    EUR: "Banca centrale europea",
    CHF: "Banca nazionale svizzera",
    USD: "Federal Reserve",
    GBP: "Banca d’Inghilterra",
    RON: "Banca Nazionale della Romania",
    UAH: "Banca nazionale dell’Ucraina",
    EGP: "Banca centrale d’Egitto",
    TRY: "Banca centrale della Repubblica di Turchia",
    TND: "Banca centrale di Tunisia",
    AED: "Banca centrale degli Emirati Arabi Uniti",
  },
  /** Language name shown in the switcher of *other* locales. */
  languageName: 'Italiano',

  ui: {
    home: 'Home',
    hubBreadcrumb: 'Convertitore di valute',
    convert: 'Converti',
    source: 'Fonte',
    otherLanguages: 'Questa pagina in altre lingue',
    relatedPairs: 'Altre coppie di valute',
    allPairs: 'Tutte le coppie di valute',
    getTheApp: 'Scarica {{app}}',
    playBadge: '{{app}} su Google Play',
    appleBadge: '{{app}} su App Store',
    screenshotsAlt: 'Schermata di {{app}}: ',
    screenHome: 'schermata principale del convertitore',
    screenChart: 'grafico storico del cambio',
    screenSelect: 'elenco delle valute con ricerca',
    factsHeading: 'Le due valute a confronto',
    factCode: 'Codice ISO 4217',
    factSymbol: 'Simbolo',
    factMinor: 'Unità minore (esponente ISO 4217)',
    factBank: 'Banca centrale emittente',
    factRegion: 'Emessa per',
    howToHeading: 'Come convertire {{base}} in {{quote}} con {{app}}',
    faqHeading: 'Domande frequenti su {{base}} e {{quote}}',
    author: 'Pagina curata da Julien Millau, sviluppatore indipendente Android e iOS.',
    disclaimer:
      'Informazioni a titolo puramente conoscitivo. Non sono un servizio di consulenza e non valgono come preventivo per un’operazione reale.',
    privacy: 'Informativa sulla privacy',
    terms: 'Condizioni d’uso',
    contact: 'Contatti',
    currencyBasket: 'un paniere di valute',
  },

  /** ≤ 60 Latin chars / ≤ 30 full-width units. No rate, no brand suffix. */
  meta: {
    titlePair: 'Convertitore da {{base}} a {{quote}} – cambio e app offline',
    descPair:
      '{{base}} e {{quote}}: chi emette le due monete e che cosa muove il cambio. A convertirle è {{app}}, gratis e offline su Android e iOS.',
    titleHub: 'App convertitore di valute – 180+ valute, anche offline',
    descHub:
      'Converti oltre 180 valute e più di 20 criptovalute, con o senza rete, e guarda i grafici da un giorno a cinque anni. Gratis su Android e iOS.',
  },

  pair: {
    h1: 'Convertire {{base}} in {{quote}}',

    /** Answer-first. First sentence ≤ 30 words, self-contained when quoted. */
    lead:
      'Per convertire {{baseName}} ({{base}}) in {{quoteName}} ({{quote}}) serve {{app}}, applicazione gratuita per Android e iOS che continua a calcolare senza rete, dagli ultimi cambi salvati. '
      + 'Questa pagina è invece la scheda della coppia: che cosa sono le due monete, chi le emette e che cosa sposta davvero il rapporto fra loro.',

    factsIntro: 'Informazioni stabili sulle due valute: cambiano nell’arco di anni, al contrario del tasso.',

    /**
     * {{pegAgainst}} può essere una valuta di qualsiasi genere o la stringa
     * «un paniere di valute»: sta quindi in apposizione, dopo la virgola, dove
     * l’italiano non chiede né articolo né preposizione articolata.
     */
    pegBlock:
      '{{quoteName}} ({{quote}}) non fluttua liberamente: il cambio è fissato dal {{pegSince}} e la parità ha un solo riferimento, {{pegAgainst}}. '
      + 'Il tasso di riferimento {{base}}/{{quote}} si sposta quindi pochissimo e il suo grafico somiglia a una linea piatta. '
      + 'Quello che cambia davvero è la cifra che ti ritrovi in mano: banche, circuiti di pagamento e uffici cambio aggiungono il proprio margine sopra il cambio fisso, per cui due operatori che citano “il tasso ufficiale” consegnano importi diversi.',

    /**
     * Usato quando una delle due valute è agganciata a una TERZA valuta — 18 di
     * queste pagine. Scrivere lì che «entrambe fluttuano» sarebbe semplicemente falso.
     */
    anchoredBlock:
      'Nella coppia {{base}}/{{quote}} si muove un lato solo. {{pegCode}} ({{pegName}}) ha un cambio agganciato a un riferimento esterno alla coppia: {{pegAnchorName}}. '
      + 'La quotazione {{base}}/{{quote}} dipende quindi quasi soltanto dal lato {{floatCode}} ({{floatName}}): quando questa coppia si sposta, il movimento arriva da lì. '
      + 'Un grafico {{base}}/{{quote}} è in pratica il grafico di {{floatCode}} contro quell’ancora e, sugli orizzonti brevi, il margine applicato da banche e uffici cambio pesa più del tasso stesso.',

    /**
     * I nomi delle due banche centrali stanno in coda alla frase, in
     * apposizione dopo la virgola. Scrivere «deciso da {{baseBank}}» obbligava
     * a una preposizione articolata che cambia con il genere del nome
     * interpolato: giusto per «dalla Banca centrale europea», sbagliato per
     * «da Bank Al-Maghrib». In apposizione il nome resta invariabile e la
     * frase regge per tutte e dodici le coppie.
     */
    floatBlock:
      'Il livello {{base}}/{{quote}} lo fissa il mercato e non un listino: la quotazione si sposta per tutta la settimana di contrattazione e a orientarla sono soprattutto le decisioni monetarie delle due banche centrali coinvolte, {{baseBank}} e {{quoteBank}}. '
      + 'Per questo nessuna pagina statica può stampare un numero e restare corretta il giorno dopo.',

    howto: [
      'Digita l’importo in {{base}}.',
      // Il nome della valuta arriva dopo i due punti: senza articolo davanti,
      // «la sterlina britannica» e «il franco svizzero» leggono entrambi bene.
      'Scegli la valuta di arrivo, cercandola per paese, per nome o per codice ISO: {{quoteName}} ({{quote}}).',
      'Tocca il risultato in {{quote}} per copiarlo o condividerlo.',
      'Aggiungi {{base}}/{{quote}} ai preferiti per ritrovarlo in cima alla lista.',
    ],

    offline:
      '{{app}} conserva sul dispositivo gli ultimi cambi scaricati, così la conversione da {{base}} a {{quote}} funziona in aereo, in metropolitana o all’estero con il roaming disattivato. Ogni valore salvato porta con sé la data del prelievo, così sai sempre quanto è vecchio il numero che stai leggendo.',

    /**
     * Shown on every page: the two questions nobody else answers honestly.
     * Answers must match the FAQPage JSON-LD verbatim, so they live here once.
     */
    faqAlways: [
      {
        q: 'Da dove prende {{app}} il tasso {{base}}/{{quote}}?',
        a: 'Da fornitori di dati finanziari, con più rilevazioni al giorno ogni volta che il dispositivo trova una connessione. {{app}} segna data e ora di ogni aggiornamento, così sai sempre quanto è vecchio il numero che stai leggendo.',
      },
      {
        q: 'In quel tasso sono comprese le spese della mia banca?',
        a: 'No. {{app}} mostra un tasso di riferimento interbancario. Banche, circuiti di carte e uffici cambio ci aggiungono sopra il proprio margine, quindi a parità di importo in {{base}} riceverai meno {{quote}} di quanto indichi quel tasso.',
      },
    ],

    /** One of these is shown per page, chosen deterministically from the pair. */
    faqRotating: [
      {
        q: '{{app}} converte {{base}} in {{quote}} anche senza internet?',
        a: 'Sì. {{app}} conserva sul dispositivo gli ultimi cambi scaricati e continua a calcolare in aereo, in metropolitana o all’estero con il roaming spento, indicando la data a cui risale il valore usato.',
      },
      {
        q: 'Ogni quanto {{app}} aggiorna il tasso {{base}}/{{quote}}?',
        a: 'Più volte nell’arco della giornata, presso fornitori di dati finanziari, a ogni occasione in cui il telefono ha campo. {{app}} scrive accanto alla cifra quando è avvenuto l’ultimo aggiornamento.',
      },
      {
        q: '{{app}} è gratis?',
        a: 'Sì: si installa gratuitamente su Android e iOS, senza creare un account e senza fare accesso. La versione gratuita si mantiene con la pubblicità, la versione Pro la toglie.',
      },
    ],

    relatedIntro: 'Altre conversioni con {{base}} o {{quote}} spiegate su questo sito:',
  },

  hub: {
    h1: 'App convertitore di valute',
    lead:
      '{{app}} è un convertitore di valute gratuito per Android e iOS: passa da una all’altra fra oltre 180 monete nazionali e più di 20 criptovalute. '
      + 'Rileva le quotazioni più volte nell’arco della giornata, le disegna su grafici da un giorno a cinque anni e continua a calcolare partendo dagli ultimi valori salvati quando la rete non c’è. Nessun account e nessun accesso da fare.',
    featuresHeading: 'Che cosa fa {{app}}',
    features: [
      'Oltre 180 monete nazionali, da cercare per paese, per nome o con le tre lettere del codice ISO 4217',
      'Più di 20 criptovalute, fra cui Bitcoin (BTC) ed Ethereum (ETH)',
      'Quotazioni rilevate più volte nell’arco della giornata presso fornitori di dati finanziari',
      'Conversione completa anche senza rete, con la data a cui risale ogni valore salvato',
      'Grafici dell’andamento da un giorno fino a cinque anni indietro',
      'Widget per la schermata iniziale ed elenco di preferiti riordinabile',
      'Numero di decimali a scelta e risultato copiabile con un tocco',
      'Nessun account da creare e nessun accesso da fare: si installa e si converte',
    ],
    pairsHeading: 'Coppie di valute spiegate in italiano',
    pairsIntro:
      'Ogni pagina qui sotto racconta una coppia ed elenca i dati stabili delle due monete.',
    editionsHeading: 'Quale versione installare',
    editionFree: 'Android — gratis',
    editionPro: 'Android — Pro',
    editionIos: 'iOS',
    editionFreeNote: 'Tutte le funzioni di conversione, con pubblicità.',
    editionProNote: 'La stessa app senza pubblicità.',
    editionIosNote: 'iPhone e iPad, widget compreso.',
    supportedHeading: 'Tutte le valute gestite da {{app}}',
    supportedIntro:
      'L’elenco completo qui sotto è letto dal catalogo interno dell’app, quindi corrisponde a ciò che viene davvero distribuito e non a una cifra arrotondata per il marketing. Passa sopra un codice per leggere il nome della valuta.',
    languagesHeading: 'Le pagine sui cambi in altre lingue',
  },
},

  pt: {

  /**
   * Official names of the issuing central banks in this language. Only the ones
   * this locale's pairs actually use are listed; anything absent falls back to
   * the English name in tools/lib/currency-facts.mjs, which is correct for
   * institutions whose name is not normally translated.
   */
  banks: {
    EUR: "Banco Central Europeu",
    USD: "Reserva Federal dos Estados Unidos",
    GBP: "Banco da Inglaterra",
    BRL: "Banco Central do Brasil",
    ARS: "Banco Central da República Argentina",
    CAD: "Banco do Canadá",
    JPY: "Banco do Japão",
    AUD: "Banco da Reserva da Austrália",
    CHF: "Banco Nacional da Suíça",
  },
  /** Nome do idioma exibido no seletor das outras edições. */
  languageName: 'Português',

  ui: {
    home: 'Início',
    hubBreadcrumb: 'Conversor de moedas',
    convert: 'Converter',
    source: 'Fonte',
    otherLanguages: 'Esta página em outros idiomas',
    relatedPairs: 'Pares de moedas relacionados',
    allPairs: 'Todos os pares de moedas',
    getTheApp: 'Baixe o {{app}}',
    playBadge: '{{app}} no Google Play',
    appleBadge: '{{app}} na App Store',
    screenshotsAlt: 'Tela do {{app}}: ',
    screenHome: 'Tela inicial do conversor',
    screenChart: 'Gráfico do histórico de cotações',
    screenSelect: 'Seletor de moedas com busca',
    factsHeading: 'As duas moedas, lado a lado',
    factCode: 'Código ISO 4217',
    factSymbol: 'Símbolo',
    factMinor: 'Casas decimais (expoente ISO 4217)',
    factBank: 'Banco central emissor',
    factRegion: 'Emitida para',
    howToHeading: 'Como converter {{base}} para {{quote}} no {{app}}',
    faqHeading: 'Dúvidas sobre {{base}} e {{quote}}',
    author: 'Publicado por Julien Millau, desenvolvedor independente de Android e iOS.',
    disclaimer:
      'Informação de referência, publicada apenas para consulta. Não é recomendação financeira nem proposta firme para nenhuma operação.',
    privacy: 'Política de privacidade',
    terms: 'Termos de uso',
    contact: 'Contato',
    currencyBasket: 'uma cesta de moedas',
  },

  /** ≤ 60 caracteres no título, ≤ 158 na descrição, já com os códigos expandidos. */
  meta: {
    titlePair: '{{base}} para {{quote}}: Conversor e Cotação no App',
    descPair:
      '{{base}} e {{quote}}: o que é cada moeda, quem a emite e o que move a cotação. Quem converte é o {{app}}, grátis e offline no Android e no iOS.',
    titleHub: 'Conversor de Moedas: 180+ Moedas, Cotação e Offline',
    descHub:
      'Converta mais de 180 moedas do mundo e 20 criptomoedas, com ou sem internet, e veja o histórico de 1 dia até 5 anos. Grátis no Android e no iOS.',
  },

  pair: {
    h1: 'Converter {{base}} para {{quote}}',

    /** Abertura padrão; cada par publicado traz a sua própria no arquivo de corredores. */
    lead:
      'Para converter {{baseName}} ({{base}}) em {{quoteName}} ({{quote}}), use o {{app}}: aplicativo gratuito para Android e iOS que segue convertendo offline pelas últimas cotações salvas. '
      + 'Esta página é a referência sobre o par em si — o que é cada moeda, qual banco central a emite e o que de fato move a cotação entre as duas.',

    factsIntro: 'Fatos duráveis sobre cada lado do par — mudam na escala de anos, ao contrário da cotação.',

    pegBlock:
      '{{quoteName}} ({{quote}}) não é uma moeda flutuante: a paridade está fixada desde {{pegSince}}, e a referência dessa paridade é a seguinte — {{pegAgainst}}. '
      + 'A cotação de referência {{base}}/{{quote}} praticamente não se mexe, e o gráfico do par fica perto de uma linha reta. '
      + 'O que muda é quanto você de fato recebe: bancos, bandeiras de cartão e casas de câmbio somam a própria margem por cima da paridade, então dois lugares que anunciam “a taxa oficial” ainda entregam valores diferentes.',

    /**
     * Entra quando um dos lados tem paridade fixa com uma TERCEIRA moeda.
     * Nesses pares, dizer que "as duas moedas flutuam" seria simplesmente falso.
     */
    anchoredBlock:
      '{{pegName}} ({{pegCode}}) não flutua livremente: a sua âncora cambial é esta — {{pegAnchorName}} —, e não a outra perna do par, {{floatName}}. '
      + 'A cotação {{base}}/{{quote}} se mexe quase só pelo lado do {{floatCode}}: quando este par muda, quem mudou foi {{floatCode}}. '
      + 'O gráfico de {{base}}/{{quote}} é, na prática, o gráfico de {{floatCode}} contra essa mesma âncora, e em prazos curtos a margem cobrada por um banco ou por uma casa de câmbio pesa mais no custo do que a própria cotação.',

    floatBlock:
      'As duas moedas flutuam, então a cotação {{base}}/{{quote}} é formada pelo mercado e não fixada por decreto. '
      + 'Pesam sobretudo as decisões de juros dos dois bancos centrais emissores: {{baseBank}} ({{base}}) e {{quoteBank}} ({{quote}}). '
      + 'É por isso que nenhuma página estática consegue imprimir um número e continuar certa no dia seguinte.',

    howto: [
      'Digite o valor em {{base}}.',
      'Escolha {{quoteName}} ({{quote}}) — a busca aceita país, nome da moeda ou código ISO.',
      'Toque no resultado em {{quote}} para copiar ou compartilhar.',
      'Deixe {{base}}/{{quote}} entre os favoritos e abra o par com um toque.',
    ],

    offline:
      'O {{app}} guarda no aparelho as últimas cotações que baixou, então a conversão de {{base}} para {{quote}} continua funcionando dentro do avião, no metrô ou fora do país com o roaming desligado. Cada cotação salva carrega a data em que foi buscada, então você sempre sabe a idade do número.',

    /** Aparece em todas as páginas e precisa bater com o JSON-LD, por isso mora aqui. */
    faqAlways: [
      {
        q: 'De onde vem a cotação {{base}}/{{quote}} do {{app}}?',
        a: 'De provedores de dados financeiros, renovada várias vezes por dia sempre que o aparelho tem conexão. O {{app}} carimba data e hora em cada atualização, então dá para saber a idade do número que está na tela.',
      },
      {
        q: 'Essa cotação já inclui as tarifas do meu banco?',
        a: 'Não. O {{app}} exibe uma referência interbancária. Bancos, bandeiras de cartão e casas de câmbio somam a própria margem por cima, então o valor em {{quote}} que chega até você pelos seus {{base}} sai menor.',
      },
    ],

    /** Uma delas entra por página, escolhida de forma determinística pelo par. */
    faqRotating: [
      {
        q: 'O {{app}} converte {{base}} para {{quote}} sem internet?',
        a: 'Sim. O {{app}} guarda no aparelho as últimas cotações que baixou e continua convertendo sem conexão, mostrando a data em que cada uma foi buscada.',
      },
      {
        q: 'De quanto em quanto tempo o {{app}} atualiza a cotação {{base}}/{{quote}}?',
        a: 'Várias vezes por dia, a partir de provedores de dados financeiros, sempre que o aparelho tem conexão. O {{app}} indica quando o número foi renovado pela última vez.',
      },
      {
        q: 'O {{app}} é gratuito?',
        a: 'Sim, gratuito para instalar no Android e no iOS, sem conta e sem login. A edição gratuita se mantém com anúncios; a edição Pro tira os anúncios.',
      },
    ],

    relatedIntro: 'Outras conversões de {{base}} e {{quote}} publicadas neste site:',
  },

  hub: {
    h1: 'Aplicativo conversor de moedas',
    lead:
      'O {{app}} é um conversor de moedas gratuito para Android e iOS que converte entre mais de 180 moedas do mundo e mais de 20 criptomoedas. '
      + 'As cotações são renovadas várias vezes por dia, o histórico vai de 1 dia até 5 anos e a conversão segue funcionando com os últimos valores salvos quando falta conexão. Sem conta e sem login.',
    featuresHeading: 'O que o {{app}} faz',
    features: [
      '180+ moedas do mundo, com busca por país, por nome da moeda ou por código ISO 4217',
      '20+ criptomoedas, entre elas Bitcoin (BTC) e Ethereum (ETH)',
      'Cotações renovadas várias vezes por dia a partir de provedores de dados financeiros',
      'Conversão offline completa pelos últimos valores salvos, com a data em que foram baixados',
      'Gráficos do histórico de cotações, de 1 dia até 5 anos',
      'Widget na tela inicial e lista de favoritos personalizável',
      'Casas decimais definidas por você e resultado copiado com um toque',
      'Sem conta e sem login — instale e converta',
    ],
    pairsHeading: 'Pares de moedas com página em português',
    pairsIntro:
      'Cada página abaixo explica um par e reúne os fatos duráveis das duas moedas.',
    editionsHeading: 'Qual versão instalar',
    editionFree: 'Android — grátis',
    editionPro: 'Android — Pro',
    editionIos: 'iOS',
    editionFreeNote: 'Todos os recursos de conversão, mantidos por anúncios.',
    editionProNote: 'O mesmo aplicativo, sem anúncios.',
    editionIosNote: 'iPhone e iPad, com suporte a widget.',
    supportedHeading: 'Todas as moedas que o {{app}} reconhece',
    supportedIntro:
      'A lista abaixo é lida do próprio catálogo do aplicativo, ou seja, é o que ele realmente traz, e não um número redondo de marketing. Passe o cursor sobre um código para ver o nome da moeda.',
    languagesHeading: 'Páginas de moedas em outros idiomas',
  },
},

  ru: {

  /**
   * Official names of the issuing central banks in this language. Only the ones
   * this locale's pairs actually use are listed; anything absent falls back to
   * the English name in tools/lib/currency-facts.mjs, which is correct for
   * institutions whose name is not normally translated.
   */
  banks: {
    USD: "Федеральная резервная система",
    RUB: "Банк России",
    EUR: "Европейский центральный банк",
    CNY: "Народный банк Китая",
    TRY: "Центральный банк Турции",
    AED: "Центральный банк ОАЭ",
    THB: "Банк Таиланда",
    GBP: "Банк Англии",
    CHF: "Швейцарский национальный банк",
    JPY: "Банк Японии",
    KRW: "Банк Кореи",
  },
  /** Language name shown in the switcher of *other* locales. */
  languageName: 'Русский',

  ui: {
    home: 'Главная',
    hubBreadcrumb: 'Конвертер валют',
    convert: 'Пересчитать',
    source: 'Источник',
    otherLanguages: 'Эта страница на других языках',
    relatedPairs: 'Похожие валютные пары',
    allPairs: 'Все валютные пары',
    getTheApp: 'Установить {{app}}',
    playBadge: '{{app}} в Google Play',
    appleBadge: '{{app}} в App Store',
    screenshotsAlt: 'Экран приложения {{app}}: ',
    screenHome: 'главный экран пересчёта',
    screenChart: 'график курса за прошлые периоды',
    screenSelect: 'выбор валюты с поиском',
    factsHeading: 'Две валюты рядом',
    factCode: 'Код ISO 4217',
    factSymbol: 'Символ',
    factMinor: 'Знаков после запятой (ISO 4217)',
    factBank: 'Центральный банк-эмитент',
    factRegion: 'Выпускается для',
    howToHeading: 'Как пересчитать {{base}} в {{quote}} в приложении {{app}}',
    faqHeading: 'Вопросы о паре {{base}} и {{quote}}',
    author: 'Публикует Жюльен Мийо, независимый разработчик приложений для Android и iOS.',
    disclaimer:
      'Сведения на странице носят справочный характер. Это не финансовая рекомендация и не котировка для сделки.',
    privacy: 'Политика конфиденциальности',
    terms: 'Условия использования',
    contact: 'Контакты',
    currencyBasket: 'корзина валют',
  },

  /** ≤ 60 знаков в заголовке, ≤ 158 в описании. Без хвоста с именем бренда. */
  meta: {
    titlePair: 'Курс {{base}} к {{quote}} — конвертер валют онлайн',
    descPair:
      '{{base}} и {{quote}}: что это за валюты, кто их выпускает и что двигает курс. Пересчёт — в приложении {{app}}, бесплатно на Android и iOS.',
    titleHub: 'Конвертер валют: 180+ валют, онлайн и офлайн',
    descHub:
      'Пересчёт 180+ мировых валют и 20+ криптовалют, с интернетом и без него, с графиками от одного дня до пяти лет. Бесплатно на Android и iOS, без регистрации.',
  },

  pair: {
    h1: 'Пересчёт {{base}} в {{quote}}',

    /**
     * Запасной вводный абзац: используется, если у пары нет своего блока.
     *
     * Названия валют подставляются в именительном падеже, поэтому стоят только
     * там, где падеж не требуется, — после тире и после кода в скобках.
     */
    lead:
      'Пересчитать {{base}} в {{quote}} можно в приложении {{app}} — бесплатном конвертере для Android и iOS, который считает по последним сохранённым курсам и без интернета. '
      + 'Эта страница отвечает за саму пару: {{base}} — это {{baseName}}, {{quote}} — {{quoteName}}; здесь собрано, кто их выпускает и что на деле двигает курс между ними.',

    factsIntro: 'Устойчивые сведения о каждой стороне пары — они меняются годами, в отличие от курса.',

    pegBlock:
      'Фиксированная сторона здесь одна — {{quote}} ({{quoteName}}): её курс задан жёстко и держится так с {{pegSince}} года, а якорем служит {{pegAgainst}}. '
      + 'Поэтому справочный курс {{base}}/{{quote}} почти не двигается, а его график близок к прямой линии. '
      + 'Меняется другое — сколько вам в итоге отдадут: банки, платёжные системы и обменные конторы добавляют к фиксированной величине свою маржу, так что два места, называющие «официальный курс», выдают разные суммы.',

    /**
     * Одна сторона привязана к ТРЕТЬЕЙ валюте (или к корзине). Писать здесь
     * «обе валюты плавающие» было бы попросту неправдой.
     *
     * Ни одно название валюты не открывает предложение: CLDR даёт их со
     * строчной буквы («дирхам ОАЭ»), и абзац начинался бы с маленькой буквы.
     */
    anchoredBlock:
      'Фиксированная сторона здесь одна — {{pegCode}} ({{pegName}}): её курс держат неподвижным, и якорем служит не {{floatName}}, а {{pegAnchorName}}. '
      + 'Поэтому пара {{base}}/{{quote}} движется практически только через сторону {{floatCode}}: сдвинулась котировка — значит, сдвинулась сторона {{floatCode}}, а не {{pegCode}}. '
      + 'График {{base}}/{{quote}} — это, по сути, график {{floatCode}} к тому же якорю, а на коротком отрезке маржа банка или обменника меняет итоговую сумму сильнее, чем само движение курса.',

    /**
     * Названия банков подставляются в именительном падеже, поэтому стоят после
     * двоеточия, приложением к «двум центральным банкам»: так предложение
     * остаётся грамотным независимо от рода и окончания подставленного имени.
     */
    floatBlock:
      'Обе валюты плавающие: курс {{base}}/{{quote}} задаёт рынок, а не чьё-то решение сверху. '
      + 'Сильнее всего на него действуют ставки, которые устанавливают два центральных банка: {{baseBank}} и {{quoteBank}}. '
      + 'Именно поэтому ни один статичный текст не может напечатать курс и остаться правым дольше нескольких минут.',

    howto: [
      'Введите сумму в {{base}}.',
      'Выберите валюту, в которую переводите: {{quote}} ({{quoteName}}) — искать можно по стране, названию валюты или коду ISO.',
      'Коснитесь результата в {{quote}}, чтобы скопировать его или отправить.',
      'Закрепите пару {{base}}/{{quote}} в избранном, чтобы открывать её одним касанием.',
    ],

    offline:
      'Приложение {{app}} хранит последние загруженные курсы прямо на устройстве, поэтому пересчёт {{base}} в {{quote}} работает в самолёте, в метро, на даче и в роуминге с выключенными данными. Рядом с сохранённым курсом стоит дата загрузки, так что вы всегда видите, насколько цифра свежая.',

    /**
     * Показывается на каждой странице: два вопроса, на которые обычно
     * отвечают уклончиво. Ответы совпадают с разметкой FAQPage дословно.
     */
    faqAlways: [
      {
        q: 'Откуда {{app}} берёт курс {{base}}/{{quote}}?',
        a: 'От поставщиков финансовых данных: приложение {{app}} подтягивает котировку по нескольку раз за день, как только у устройства появляется связь, и ставит рядом отметку времени — видно, насколько свежая цифра сейчас на экране.',
      },
      {
        q: 'Входит ли в этот курс комиссия моего банка?',
        a: 'Нет. Приложение {{app}} показывает межбанковский справочный курс. Банки, платёжные системы и обменные пункты добавляют сверху собственную маржу, поэтому за ту же сумму в {{base}} на руки вы получите меньше, чем насчитало приложение.',
      },
    ],

    /** По одному на страницу, выбирается детерминированно по слагу пары. */
    faqRotating: [
      {
        q: 'Работает ли пересчёт {{base}} в {{quote}} без интернета?',
        a: 'Да. Приложение {{app}} хранит последние загруженные курсы на самом устройстве и продолжает считать без сети, показывая дату, на которую эти курсы были получены.',
      },
      {
        q: 'Как часто {{app}} обновляет курс {{base}}/{{quote}}?',
        a: 'По нескольку раз за день, от поставщиков финансовых данных, каждый раз, когда у устройства есть связь. Время последнего обновления приложение {{app}} показывает рядом с курсом.',
      },
      {
        q: 'Сколько стоит {{app}}?',
        a: 'Установка бесплатна и на Android, и на iOS — без аккаунта и без входа по логину. Бесплатная версия показывает рекламу, версия Pro её убирает.',
      },
    ],

    relatedIntro: 'Другие пересчёты с участием {{base}} и {{quote}}, разобранные на сайте:',
  },

  hub: {
    h1: 'Приложение-конвертер валют',
    lead:
      '{{app}} — бесплатный конвертер валют для Android и iOS: 180+ мировых валют и 20+ криптовалют в одном списке. '
      + 'Курсы подтягиваются по нескольку раз за день, строятся графики от одного дня до пяти лет, а при отсутствии связи пересчёт продолжается по последним сохранённым данным. Без аккаунта и без входа по логину.',
    featuresHeading: 'Что умеет {{app}}',
    features: [
      '180+ мировых валют с поиском по названию страны, названию валюты и коду ISO 4217',
      '20+ криптовалют, включая Bitcoin (BTC) и Ethereum (ETH)',
      'Курсы подтягиваются по нескольку раз за день от поставщиков финансовых данных',
      'Полноценный пересчёт офлайн по сохранённым курсам, с датой их загрузки',
      'Графики курса за период от одного дня до пяти лет',
      'Виджет на домашний экран и настраиваемый список избранных пар',
      'Количество знаков после запятой задаёте вы, результат копируется одним касанием',
      'Ни аккаунта, ни входа по логину — установите и считайте',
    ],
    pairsHeading: 'Валютные пары, разобранные на русском',
    pairsIntro:
      'Каждая страница ниже посвящена одной паре: что это за валюты, кто их выпускает и что двигает курс между ними.',
    editionsHeading: 'Какую версию ставить',
    editionFree: 'Android — бесплатно',
    editionPro: 'Android — Pro',
    editionIos: 'iOS',
    editionFreeNote: 'Все функции пересчёта, поддерживается рекламой.',
    editionProNote: 'То же приложение без рекламы.',
    editionIosNote: 'iPhone и iPad, с поддержкой виджета.',
    supportedHeading: 'Все валюты, которые поддерживает {{app}}',
    supportedIntro:
      'Список ниже прочитан из собственного каталога приложения, то есть это ровно то, что в нём есть, а не округлённая маркетинговая цифра. Наведите курсор на код, чтобы увидеть название валюты.',
    languagesHeading: 'Страницы о валютах на других языках',
  },
},

  tr: {

  /**
   * Official names of the issuing central banks in this language. Only the ones
   * this locale's pairs actually use are listed; anything absent falls back to
   * the English name in tools/lib/currency-facts.mjs, which is correct for
   * institutions whose name is not normally translated.
   */
  banks: {
    USD: "Federal Rezerv",
    TRY: "Türkiye Cumhuriyet Merkez Bankası",
    EUR: "Avrupa Merkez Bankası",
    GBP: "İngiltere Merkez Bankası",
    CHF: "İsviçre Ulusal Bankası",
    SAR: "Suudi Arabistan Merkez Bankası",
    AED: "BAE Merkez Bankası",
    RUB: "Rusya Merkez Bankası",
    JPY: "Japonya Merkez Bankası",
    CAD: "Kanada Merkez Bankası",
    AUD: "Avustralya Merkez Bankası",
    QAR: "Katar Merkez Bankası",
  },
  /** Language name shown in the switcher of *other* locales. */
  languageName: 'Türkçe',

  ui: {
    home: 'Ana sayfa',
    hubBreadcrumb: 'Döviz çevirici',
    convert: 'Çevir',
    source: 'Kaynak',
    otherLanguages: 'Bu sayfanın diğer dilleri',
    relatedPairs: 'İlgili para birimi çiftleri',
    allPairs: 'Bütün para birimi çiftleri',
    getTheApp: '{{app}} uygulamasını edinin',
    playBadge: 'Google Play üzerinde {{app}}',
    appleBadge: 'App Store üzerinde {{app}}',
    screenshotsAlt: '{{app}} ekranı: ',
    screenHome: 'Çevirici ana ekranı',
    screenChart: 'Geçmişe dönük kur grafiği',
    screenSelect: 'Aramalı para birimi listesi',
    factsHeading: 'İki para birimi yan yana',
    factCode: 'ISO 4217 kodu',
    factSymbol: 'Simge',
    factMinor: 'Alt birim basamağı (ISO 4217 üssü)',
    factBank: 'İhraç eden merkez bankası',
    factRegion: 'Hangi ülke ya da bölge için basılır',
    howToHeading: '{{app}} ile {{base}} tutarı {{quote}} cinsine nasıl çevrilir',
    faqHeading: '{{base}} {{quote}} çevirisi hakkında sorular',
    author: 'Yayımlayan: Julien Millau, bağımsız Android ve iOS geliştiricisi.',
    disclaimer:
      'Yalnızca bilgi amaçlı referans içeriktir. Yatırım tavsiyesi değildir ve hiçbir işlem için teklif niteliği taşımaz.',
    privacy: 'Gizlilik politikası',
    terms: 'Kullanım koşulları',
    contact: 'İletişim',
    currencyBasket: 'bir para birimi sepeti',
  },

  /** ≤ 60 Latin chars. Kod genişledikten sonra da sığmalı. */
  meta: {
    titlePair: '{{base}} {{quote}} Çevirici – Kur Hesaplama, Çevrimdışı',
    descPair:
      '{{base}} {{quote}} çifti: iki para birimini kim basar, kuru ne hareket ettirir. Çeviriyi {{app}} yapar; ücretsiz, çevrimdışı, Android ve iOS.',
    titleHub: 'Döviz Çevirici Uygulaması – 180+ Para Birimi, Çevrimdışı',
    descHub:
      'Dünyadan 180+ para birimini ve 20+ kripto varlığı bağlantılı ya da bağlantısız çevirin; 1 gün ile 5 yıl arası grafikler. Android ve iOS için ücretsiz.',
  },

  pair: {
    h1: '{{baseName}} kaç {{quoteName}} eder? ({{base}}/{{quote}})',

    /** Cevap önce. İlk cümle 30 kelimeyi geçmez, alıntılandığında tek başına anlaşılır. */
    lead:
      '{{baseName}} ({{base}}) tutarını {{quoteName}} ({{quote}}) cinsine {{app}} uygulamasında çevirirsiniz: Android ve iOS için ücretsiz, bağlantı yokken de son kaydettiği kurlarla hesap yapar. '
      + 'Bu sayfa çiftin kendi künyesidir: iki para birimini hangi merkez bankası basar, aralarındaki kuru asıl ne hareket ettirir, elinize geçen tutarı hangi makas belirler.',

    factsIntro: 'Çiftin iki tarafına ait kalıcı künye bilgileri — kurun aksine bunlar yıllar ölçeğinde değişir.',

    pegBlock:
      '{{quoteName}} ({{quote}}), {{pegAgainst}} karşısında serbestçe dalgalanmıyor: {{pegSince}} yılından bu yana sabit bir orana bağlı. '
      + '{{base}}/{{quote}} referans kuru bu yüzden neredeyse yerinde durur ve grafiği düz bir çizgiye benzer. '
      + 'Asıl değişen, elinize geçen tutardır: bankalar, kart kuruluşları ve döviz büroları sabit oranın üzerine kendi makasını ekler; "resmî kur" diyen iki kurum size farklı tutarlar verebilir.',

    /**
     * Bir taraf ÜÇÜNCÜ bir para birimine bağlıyken kullanılır. Bu sayfalarda
     * "iki para birimi de serbest dalgalanıyor" demek düpedüz yanlış olurdu.
     */
    anchoredBlock:
      '{{pegName}} ({{pegCode}}), {{floatName}} karşısında değil, {{pegAnchorName}} karşısında sabit tutulur. '
      + '{{base}}/{{quote}} kuru bu yüzden neredeyse tamamen tek bir tarafın hareketiyle belirlenir: {{floatName}} ({{floatCode}}). Çift oynadığında yer değiştiren taraf odur. '
      + '{{base}}/{{quote}} grafiği aslında {{floatCode}} ile {{pegAnchorName}} arasındaki grafiktir; kısa vadede bankanın ya da döviz bürosunun koyduğu makas, maliyette kurun kendisinden daha büyük yer tutar.',

    floatBlock:
      '{{base}}/{{quote}} paritesini hiçbir kurum sabitlemiş değil; kuru arz ile talep belirler. '
      + 'Faiz kararlarıyla beklentiyi yönlendiren iki kurum şunlardır: {{baseBank}} ve {{quoteBank}}. '
      + 'Bu yüzden sabit bir sayfaya kur yazıp uzun süre doğru kalması mümkün değildir.',

    howto: [
      '{{base}} tutarını yazın.',
      'Karşı para birimini seçin: {{quoteName}} ({{quote}}) — ülke, para birimi adı ya da ISO koduyla aratabilirsiniz.',
      'Çıkan {{quote}} sonucuna dokunup kopyalayın veya paylaşın.',
      '{{base}}/{{quote}} çiftini favorilere sabitleyin, tek dokunuşla açılsın.',
    ],

    offline:
      '{{app}} indirdiği en son kurları cihazda saklar; böylece {{base}} {{quote}} çevirisi uçakta, metroda veya yurt dışında dolaşım kapalıyken de çalışır. Kaydedilen kurlar alındıkları tarihi de taşır, yani elinizdeki rakamın ne kadar eski olduğunu her zaman bilirsiniz.',

    /**
     * Her sayfada görünür. Metinler FAQPage JSON-LD ile birebir aynı olmalı,
     * bu yüzden tek bir yerde duruyorlar.
     */
    faqAlways: [
      {
        q: '{{app}} {{base}}/{{quote}} kurunu nereden alıyor?',
        a: 'Finansal veri sağlayıcılarından alır ve cihaz bağlantı buldukça gün içinde birkaç kez tazeler. {{app}} her güncellemenin saatini yazdığı için ekrandaki {{base}}/{{quote}} rakamının ne kadar eski olduğunu her zaman görürsünüz.',
      },
      {
        q: 'Bu kurun içinde bankamın masrafları var mı?',
        a: 'Hayır. {{app}} bankalar arası bir referans kur gösterir. Bankalar, kart kuruluşları ve döviz büroları bunun üzerine kendi makasını ekler; dolayısıyla {{base}} tutarınız karşılığında elinize geçen {{quote}} daha az olur.',
      },
    ],

    /** Sayfa başına biri gösterilir, çiftin kendisinden belirlenir. */
    faqRotating: [
      {
        q: '{{app}} internet olmadan {{base}} {{quote}} çevirir mi?',
        a: 'Evet. {{app}} indirdiği son kurları cihazda saklar ve uçakta, metroda veya dolaşım kapalıyken çevirmeyi sürdürür; kaydettiği kurların alındığı tarihi de birlikte gösterir.',
      },
      {
        q: '{{app}} {{base}}/{{quote}} kurunu ne sıklıkla yeniliyor?',
        a: 'Gün içinde birkaç kez, cihaz çevrimiçi olduğu sürece. İki güncelleme arasında uygulamadaki değer sabit kalır, piyasa ise hareket etmeyi sürdürür; bu yüzden tazelenme anı ekranda yazılıdır.',
      },
      {
        q: '{{app}} ücretsiz mi?',
        a: 'Evet, Android ve iOS tarafında kurulumu ücretsizdir; üyelik ya da giriş istemez. Ücretsiz sürüm reklamla desteklenir, Pro sürümü reklamları kaldırır.',
      },
    ],

    relatedIntro: 'Bu sitede yer alan diğer {{base}} ve {{quote}} çevirileri:',
  },

  hub: {
    h1: 'Döviz çevirici uygulaması',
    lead:
      '{{app}}, Android ve iOS için ücretsiz bir döviz çeviricidir; dünyadan 180\'in üzerinde para birimi ile 20\'yi aşkın kripto varlık arasında hesap yapar. '
      + 'Kurları gün içinde birkaç kez tazeler, 1 gün ile 5 yıl arasında grafiğe döker ve bağlantı kesildiğinde en son sakladığı kurlarla çevirmeyi sürdürür. Üyelik ya da giriş gerekmez.',
    featuresHeading: '{{app}} neler yapar',
    features: [
      'Dünyadan 180\'in üzerinde para birimi; ülke, para birimi adı veya ISO 4217 koduyla aranabilir',
      'Bitcoin (BTC) ve Ethereum (ETH) dahil 20\'yi aşkın kripto varlık',
      'Finansal veri sağlayıcılarından gün içinde birkaç kez tazelenen kurlar',
      'Bağlantı yokken en son saklanan kurlarla tam çeviri, alındıkları tarih görünür halde',
      '1 gün ile 5 yıl arasında geçmişe dönük grafikler',
      'Ana ekran widget\'ı ve düzenlenebilir favori listesi',
      'Kendi belirlediğiniz ondalık hassasiyeti ve tek dokunuşla kopyalanan sonuç',
      'Üyelik yok, giriş yok — kurun ve çevirmeye başlayın',
    ],
    pairsHeading: 'Türkçe yayımlanan para birimi çiftleri',
    pairsIntro:
      'Aşağıdaki her sayfa tek bir çifti anlatır ve iki para biriminin kalıcı künyesini listeler.',
    editionsHeading: 'Hangi sürümü kurmalı',
    editionFree: 'Android — ücretsiz',
    editionPro: 'Android — Pro',
    editionIos: 'iOS',
    editionFreeNote: 'Bütün çeviri özellikleri, reklam destekli.',
    editionProNote: 'Aynı uygulamanın reklamsız hali.',
    editionIosNote: 'iPhone ve iPad, widget desteğiyle.',
    supportedHeading: '{{app}} içindeki bütün para birimleri',
    supportedIntro:
      'Aşağıdaki liste doğrudan uygulamanın kendi kataloğundan okunur; yani yuvarlanmış bir pazarlama rakamı değil, uygulamanın gerçekten içerdiği kadrodur. Para biriminin adını görmek için koda gelin.',
    languagesHeading: 'Diğer dillerdeki kur sayfaları',
  },
},

  pl: {

  /**
   * Official names of the issuing central banks in this language. Only the ones
   * this locale's pairs actually use are listed; anything absent falls back to
   * the English name in tools/lib/currency-facts.mjs, which is correct for
   * institutions whose name is not normally translated.
   *
   * Deliberately absent: PLN, whose fallback "Narodowy Bank Polski" is already
   * the Polish name; NOK, SEK and DKK, because Polish keeps "Norges Bank",
   * "Sveriges Riksbank" and "Danmarks Nationalbank" as proper nouns — the
   * corridor texts use exactly those forms, and Polish prose reaches for
   * "norweski/szwedzki/duński bank centralny" only as a description, never as
   * the institution's name.
   */
  banks: {
    EUR: "Europejski Bank Centralny",
    CHF: "Szwajcarski Bank Narodowy",
    USD: "System Rezerwy Federalnej",
    GBP: "Bank Anglii",
    UAH: "Narodowy Bank Ukrainy",
    CZK: "Czeski Bank Narodowy",
    HUF: "Narodowy Bank Węgier",
  },
  /** Language name shown in the switcher of *other* locales. */
  languageName: 'Polski',

  ui: {
    home: 'Strona główna',
    hubBreadcrumb: 'Przelicznik walut',
    convert: 'Przelicz',
    source: 'Źródło',
    otherLanguages: 'Ta strona w innych językach',
    relatedPairs: 'Powiązane pary walutowe',
    allPairs: 'Wszystkie pary walutowe',
    getTheApp: 'Pobierz {{app}}',
    playBadge: '{{app}} w Google Play',
    appleBadge: '{{app}} w App Store',
    screenshotsAlt: 'Ekran aplikacji {{app}}: ',
    screenHome: 'Ekran główny przelicznika',
    screenChart: 'Wykres historyczny kursu wymiany',
    screenSelect: 'Lista walut z wyszukiwarką',
    factsHeading: 'Obie waluty obok siebie',
    factCode: 'Kod ISO 4217',
    factSymbol: 'Symbol',
    factMinor: 'Jednostka podrzędna (wykładnik ISO 4217)',
    factBank: 'Bank centralny emitujący walutę',
    factRegion: 'Obszar emisji',
    howToHeading: 'Jak przeliczyć {{base}} na {{quote}} w {{app}}',
    faqHeading: 'Pytania o przeliczanie {{base}} na {{quote}}',
    author: 'Publikuje Julien Millau, niezależny twórca aplikacji na Androida oraz iOS.',
    disclaimer:
      'Materiał wyłącznie informacyjny. To nie jest porada finansowa ani kurs, po którym zawrzesz transakcję.',
    privacy: 'Polityka prywatności',
    terms: 'Regulamin',
    contact: 'Kontakt',
    currencyBasket: 'koszyk walut',
  },

  /** ≤ 60 Latin chars. No rate, no brand suffix. */
  meta: {
    titlePair: 'Przelicznik {{base}} na {{quote}} – kurs i kalkulator',
    descPair:
      '{{base}} i {{quote}}: czym są obie waluty, kto je emituje i co rusza ich kursem. Przelicza je {{app}} — za darmo, offline, Android oraz iOS.',
    titleHub: 'Przelicznik walut – kalkulator 180+ walut, offline',
    descHub:
      'Kalkulator walut: ponad 180 walut świata i 20 kryptowalut, online i offline, z wykresami od jednego dnia do pięciu lat. Android oraz iOS, bez konta.',
  },

  pair: {
    h1: 'Przelicz {{base}} na {{quote}}',

    /**
     * Fallback lead; every published pair overrides it with its corridor lead.
     *
     * The conversion happens in the app, not on the page, so the first sentence
     * says outright what {{app}} does and the second gives the page its real
     * job: describing the pair.
     *
     * Everything the verb governs is an ISO code, never a currency name. Polish
     * would demand the accusative after "przelicza" ("przelicza koronę
     * norweską", not "korona norweska"), and the template cannot decline a name
     * it does not know; the codes never inflect. The two names therefore appear
     * only in the nominative, after "czym są".
     */
    lead:
      'Parę {{base}}/{{quote}} przelicza {{app}} — bezpłatna aplikacja na Androida oraz iOS, która działa dalej bez zasięgu, na ostatnio zapisanych kursach. '
      + 'Ta strona opisuje natomiast samą parę: czym są {{baseName}} ({{base}}) oraz {{quoteName}} ({{quote}}), który bank centralny je emituje i co naprawdę rusza kursem między nimi.',

    factsIntro: 'Trwałe fakty o obu stronach pary — zmieniają się w skali lat, inaczej niż kurs.',

    /**
     * "wobec {{pegAgainst}}" would need the genitive of a name the template
     * cannot decline, so the anchor moved into a copular predicate — "kotwicą
     * jest X" takes the nominative whatever X turns out to be, including the
     * basket wording from ui.currencyBasket.
     */
    pegBlock:
      'Jedna strona tej pary nie płynie swobodnie: {{quoteName}} ({{quote}}). '
      + 'Kotwicą jest {{pegAgainst}}, a kurs utrzymywany jest od {{pegSince}} roku. '
      + 'Kurs referencyjny {{base}}/{{quote}} prawie się więc nie rusza, a jego wykres przypomina linię prostą. '
      + 'Zmienia się co innego: kwota, którą realnie dostajesz. Banki, organizacje kartowe i kantory doliczają do usztywnionego kursu własną marżę, więc dwa punkty powołujące się na „kurs oficjalny” wypłacą różne sumy.',

    /**
     * Used when one leg is pegged to a THIRD currency. In Polish that is
     * DKK/PLN: the krone is tied to the euro, not to the złoty, so "both
     * currencies float" would be simply untrue. Every placeholder here stays
     * in the nominative — the anchor can be a name of any gender, or the
     * basket wording, and Polish case endings cannot be guessed by a template.
     */
    anchoredBlock:
      'Sztywny kurs ma tu jedna strona pary: {{pegName}} ({{pegCode}}). Kotwicą jest {{pegAnchorName}}, a nie {{floatName}}. '
      + 'Cały ruch pary {{base}}/{{quote}} bierze się więc ze strony {{floatCode}}: kiedy zmienia się kurs {{floatCode}} wobec kotwicy, przesuwa się cała para, bo {{pegCode}} kotwicy się trzyma. '
      + 'Wykres {{base}}/{{quote}} jest w praktyce wykresem kursu {{floatCode}} wobec kotwicy, a nie samodzielnego notowania {{pegCode}}. '
      + 'W krótkim terminie marża banku albo kantoru waży w koszcie wymiany więcej niż sam kurs.',

    /**
     * The two bank names sit after a colon, as an apposition to "dwa banki
     * centralne". Any other slot would force a case ending onto a proper noun
     * the template cannot inflect — "Norges Bank", "Sveriges Riksbank" and
     * "System Rezerwy Federalnej" decline nothing alike.
     */
    floatBlock:
      'Obie waluty są płynne, więc kurs {{base}}/{{quote}} wyznacza rynek, a nie decyzja administracyjna. '
      + 'Najmocniej waży polityka stóp procentowych, a prowadzą ją dwa banki centralne: {{baseBank}} oraz {{quoteBank}}. '
      + 'Dlatego żadna statyczna strona nie może wydrukować kursu i pozostać aktualna.',

    howto: [
      'Wpisz kwotę w {{base}}.',
      'Wybierz walutę docelową: {{quoteName}} ({{quote}}). Szukaj po kodzie ISO 4217, po nazwie waluty albo po nazwie państwa.',
      'Dotknij wyniku w {{quote}}, żeby go skopiować lub wysłać dalej.',
      'Przypnij parę {{base}}/{{quote}} do ulubionych i miej ją pod ręką po otwarciu aplikacji.',
    ],

    offline:
      '{{app}} trzyma ostatnio pobrane kursy w pamięci telefonu, więc przeliczenie {{base}} na {{quote}} działa w samolocie, w metrze i za granicą z wyłączonym roamingiem. Zapisane kursy noszą datę pobrania, dzięki czemu zawsze wiadomo, jak stara jest liczba na ekranie.',

    /**
     * Shown on every page: the two questions nobody else answers honestly.
     * Answers must match the FAQPage JSON-LD verbatim, so they live here once.
     */
    faqAlways: [
      {
        q: 'Skąd {{app}} bierze kurs {{base}}/{{quote}}?',
        a: 'Od dostawców danych finansowych, po kilka razy dziennie, za każdym razem gdy telefon ma połączenie. Każde pobranie {{app}} opatruje datą i godziną, więc zawsze widać, jak stara jest liczba na ekranie.',
      },
      {
        q: 'Czy ten kurs zawiera prowizję i spread mojego banku?',
        a: 'Nie. {{app}} pokazuje kurs z rynku międzybankowego. Banki, organizacje kartowe i kantory doliczają do niego własną marżę, więc za swoje {{base}} realnie dostaniesz mniej {{quote}}.',
      },
    ],

    /** One of these is shown per page, chosen deterministically from the pair. */
    faqRotating: [
      {
        q: 'Czy {{app}} przelicza {{base}} na {{quote}} bez internetu?',
        a: 'Tak. Ostatnio pobrane kursy zostają w pamięci telefonu, więc {{app}} liczy dalej w samolocie, w metrze i przy wyłączonym roamingu, pokazując przy tym datę ich pobrania.',
      },
      {
        q: 'Jak często {{app}} odświeża kurs {{base}}/{{quote}}?',
        a: 'Kilka razy w ciągu dnia, przy każdym połączeniu telefonu z siecią. Rynek walutowy idzie jednak dalej bez przerwy, dlatego {{app}} podaje przy kursie moment, z którego on pochodzi.',
      },
      {
        q: 'Czy {{app}} jest bezpłatna?',
        a: 'Tak. Instalacja na Androidzie oraz iOS nic nie kosztuje, bez konta i bez logowania. Wersja bezpłatna utrzymuje się z reklam, a wersja Pro je usuwa.',
      },
    ],

    relatedIntro: 'Inne przeliczenia z udziałem {{base}} i {{quote}} opisane w tym serwisie:',
  },

  hub: {
    h1: 'Kalkulator i przelicznik walut',
    lead:
      '{{app}} to bezpłatny przelicznik walut na Androida i iOS, który liczy ponad 180 walut świata oraz ponad 20 kryptowalut. '
      + 'Kursy pobiera po kilka razy dziennie, rysuje z nich wykresy od jednego dnia do pięciu lat wstecz i przelicza dalej z zapisanych danych, kiedy telefon nie ma zasięgu. Bez konta i bez logowania.',
    featuresHeading: 'Co robi {{app}}',
    features: [
      'Ponad 180 walut świata, wyszukiwanych po kodzie ISO 4217, po nazwie waluty albo po nazwie państwa',
      'Ponad 20 kryptowalut, w tym Bitcoin (BTC) oraz Ethereum (ETH)',
      'Kursy pobierane po kilka razy dziennie od dostawców danych finansowych',
      'Pełne przeliczanie offline na ostatnio zapisanych kursach, razem z datą ich pobrania',
      'Wykresy historyczne kursu — od jednego dnia do pięciu lat wstecz',
      'Widżet na ekran główny i własna lista ulubionych par walutowych',
      'Liczbę miejsc po przecinku ustawiasz sam, a każdy wynik kopiujesz jednym dotknięciem',
      'Bez konta i bez logowania — instalujesz i przeliczasz',
    ],
    pairsHeading: 'Pary walutowe opisane po polsku',
    pairsIntro:
      'Każda strona poniżej opisuje jedną parę i zestawia trwałe fakty o obu walutach.',
    editionsHeading: 'Którą wersję zainstalować',
    editionFree: 'Android — bezpłatna',
    editionPro: 'Android — Pro',
    editionIos: 'iOS',
    editionFreeNote: 'Wszystkie funkcje przeliczania, utrzymywane z reklam.',
    editionProNote: 'Ta sama aplikacja bez reklam.',
    editionIosNote: 'iPhone i iPad, razem z widżetem.',
    supportedHeading: 'Wszystkie waluty obsługiwane przez {{app}}',
    supportedIntro:
      'Lista poniżej pochodzi z katalogu samej aplikacji, więc pokazuje to, co naprawdę jest w środku, a nie zaokrągloną liczbę z reklamy. Najedź na kod, żeby zobaczyć nazwę waluty.',
    languagesHeading: 'Strony walutowe w innych językach',
  },
},

  ja: {

  /**
   * Official names of the issuing central banks in this language. Only the ones
   * this locale's pairs actually use are listed; anything absent falls back to
   * the English name in tools/lib/currency-facts.mjs, which is correct for
   * institutions whose name is not normally translated.
   */
  banks: {
    USD: "連邦準備制度",
    JPY: "日本銀行",
    KRW: "韓国銀行",
    EUR: "欧州中央銀行",
    TWD: "中華民国中央銀行",
    THB: "タイ銀行",
    CNY: "中国人民銀行",
    GBP: "イングランド銀行",
    VND: "ベトナム国家銀行",
    PHP: "フィリピン中央銀行",
    AUD: "オーストラリア準備銀行",
    HKD: "香港金融管理局",
    SGD: "シンガポール金融管理局",
  },
  /** 他ロケールの言語切り替えに表示される言語名。 */
  languageName: '日本語',

  ui: {
    home: 'ホーム',
    hubBreadcrumb: '通貨換算',
    convert: '換算する',
    source: '出典',
    otherLanguages: 'このページの他の言語版',
    relatedPairs: '関連する通貨ペア',
    allPairs: 'すべての通貨ペアを見る',
    getTheApp: '{{app}} を入手する',
    playBadge: 'Google Play で {{app}} を入手',
    appleBadge: 'App Store で {{app}} を入手',
    screenshotsAlt: '{{app}} の画面: ',
    screenHome: '換算のホーム画面',
    screenChart: '為替レートの推移チャート',
    screenSelect: '検索できる通貨リスト',
    factsHeading: '2つの通貨を並べて確認する',
    factCode: 'ISO 4217 コード',
    factSymbol: '通貨記号',
    factMinor: '補助単位（ISO 4217 の指数）',
    factBank: '発行する中央銀行',
    factRegion: '発行地域',
    howToHeading: '{{app}} で {{base}} を {{quote}} に換算する手順',
    faqHeading: '{{base}} から {{quote}} への換算でよくある質問',
    author: 'Android と iOS を個人で開発している Julien Millau が公開しています。',
    disclaimer:
      '参考情報としてのみ提供しています。金融アドバイスではなく、実際の取引に適用される条件を保証するものでもありません。',
    privacy: 'プライバシーポリシー',
    terms: '利用規約',
    contact: 'お問い合わせ',
    currencyBasket: '通貨バスケット',
  },

  /** 全角は2カウント。タイトルは30以内、説明文は80以内。 */
  meta: {
    titlePair: '{{base}}/{{quote}} 換算・為替レート計算',
    descPair:
      '{{base}}と{{quote}}の基礎知識と、レートを動かす要因。換算はオフライン対応の無料アプリで。',
    titleHub: '通貨換算アプリ - 180通貨以上',
    descHub:
      '180以上の通貨と20以上の暗号資産に対応。オフラインでも使える無料の為替計算機。',
  },

  pair: {
    h1: '{{base}} を {{quote}} に換算する',

    /** 結論を先に。最初の一文だけで意味が通るように。 */
    lead:
      '{{baseName}}（{{base}}）を{{quoteName}}（{{quote}}）に換算するなら、Android と iOS で無料の {{app}} を使ってください。通信がなくても、最後に保存したレートで動き続けます。'
      + 'このページが引き受けるのは通貨ペアそのものの説明です。それぞれがどんな通貨で、どの中央銀行が発行し、二つのあいだのレートを実際に動かしているのは何かをまとめています。',

    factsIntro: '両方の通貨について、年単位でしか変わらない事実をまとめました。レートと違い、ここは頻繁には動きません。',

    pegBlock:
      '{{quoteName}}（{{quote}}）のレートは、ペッグの相手である{{pegAgainst}}に対しては動きません。{{pegSince}} 年以降、その水準が維持されています。'
      + 'そのため {{base}}/{{quote}} の参考レートはほとんど動かず、チャートを描いてもほぼ平坦な線になります。'
      + '実際に変わるのは受け取る金額のほうです。銀行、カード会社、両替所はこの水準の上に独自の手数料を上乗せするため、同じ「公式レート」を掲げる二つの窓口でも、手にする金額は違ってきます。',

    /**
     * 片方が「第三の通貨」にペッグされている場合。ここで「どちらも変動相場制」と
     * 書けば事実に反するため、専用の説明を置く。
     */
    anchoredBlock:
      '{{pegName}}（{{pegCode}}）がペッグされている相手は{{pegAnchorName}}であって、{{floatName}}ではありません。'
      + 'そのため {{base}}/{{quote}} のレートは、ほぼ {{floatCode}} 側の動きだけで決まります。このペアが動いたときに動いたのは、{{floatName}}のほうです。'
      + '{{base}}/{{quote}} のチャートは、実質的に {{floatCode}} と{{pegAnchorName}}のチャートを見ているのと変わりません。数日から数週間の単位で見れば、銀行や両替所が上乗せする手数料のほうが、レートの変化よりも受取額を大きく左右します。',

    /**
     * {{baseBank}} と {{quoteBank}} は日本語の銀行名に置き換わる。地の文に
     * 「A と B の」と挟むと前後に半角空きが入ってしまうので、括弧内の並列に
     * 逃がして、置換された名前の左右に空白が出ない形にしてある。
     */
    floatBlock:
      '{{base}} と {{quote}} のあいだに固定レートはなく、{{base}}/{{quote}} の水準は市場の取引で決まります。'
      + '発行元である二つの中央銀行（{{baseBank}}、{{quoteBank}}）の金融政策や金利差を映しながら、取引が続くかぎり動き続けます。'
      + '静的なページにレートを書き込んでも翌日には古くなるのは、このためです。',

    howto: [
      '{{base}} の金額を入力します。',
      '{{quoteName}}（{{quote}}）を選びます。国名、通貨名、ISO コードのいずれでも検索できます。',
      '表示された {{quote}} の金額をタップして、コピーまたは共有します。',
      '{{base}}/{{quote}} をお気に入りに登録し、次回からワンタップで開きます。',
    ],

    offline:
      '{{app}} はダウンロード済みの為替レートを端末に保存するため、機内でも、地下鉄でも、ローミングを切った旅先でも、{{base}} から {{quote}} への換算を続けられます。保存されたレートには取得日時が付くので、その数字がいつのものかを常に確認できます。',

    /**
     * 全ページ共通の2問。FAQPage の JSON-LD と一字一句同じにするため、
     * 文言はここに一度だけ置く。
     */
    faqAlways: [
      {
        q: '{{base}}/{{quote}} のレートを、{{app}} はどこから取り込んでいますか。',
        a: '金融データの提供元からで、端末が通信できるときに1日に複数回取り込みます。{{app}} は取り込むたびに時刻を記録するので、画面に出ている数字がいつのものかは常に確認できます。',
      },
      {
        q: 'そのレートに銀行の手数料は含まれていますか。',
        a: 'いいえ。{{app}} が示すのは銀行間の参考レートです。銀行、カード会社、両替所はそれぞれの手数料を上乗せするため、{{base}} を実際に {{quote}} へ替えたときの受取額は、これより少なくなります。',
      },
    ],

    /** ページごとに1問だけ、ペアから決まる形で選ばれる。 */
    faqRotating: [
      {
        q: '{{app}} は、インターネットがなくても {{base}} を {{quote}} に換算できますか。',
        a: 'はい。{{app}} は最後にダウンロードしたレートを端末に保存し、圏外でも換算を続けます。画面には、そのレートを取得した日付が添えられます。',
      },
      {
        q: '{{app}} は {{base}}/{{quote}} のレートをどのくらいの頻度で更新しますか。',
        a: '端末が通信できるたびに、金融データの提供元から1日に複数回です。最後に取り込んだ日時は {{app}} の画面に表示されます。',
      },
      {
        q: '{{app}} は無料ですか。',
        a: 'はい。Android と iOS に無料でインストールでき、アカウント登録もログインも不要です。無料版は広告によって運営し、Pro 版では広告が出ません。',
      },
    ],

    relatedIntro: 'このサイトで扱っている、{{base}} と {{quote}} に関連するほかの換算ページです。',
  },

  hub: {
    h1: '通貨換算アプリ',
    lead:
      '{{app}} は、180以上の世界の通貨と20以上の暗号資産を換算できる、Android と iOS 向けの無料アプリです。'
      + '為替レートを1日に複数回更新し、1日から5年までのチャートを描き、通信がないときは保存済みのレートで換算を続けます。'
      + 'アカウント登録もログインも不要です。',
    featuresHeading: '{{app}} でできること',
    features: [
      '180以上の世界の通貨に対応し、国名、通貨名、ISO 4217 コードで検索できます',
      'ビットコイン（BTC）やイーサリアム（ETH）を含む20以上の暗号資産に対応',
      '金融データ提供元から、為替レートを1日に複数回更新',
      '通信がなくても、保存済みのレートで換算を継続。取得日時も表示します',
      '1日から5年までの期間で描ける推移チャート',
      'ホーム画面ウィジェットと、並べ替えできるお気に入りリスト',
      '小数桁数を自分で設定でき、結果はワンタップでコピーできます',
      'アカウント不要、ログイン不要。インストールすればすぐ換算できます',
    ],
    pairsHeading: '日本語で公開している通貨ペア',
    pairsIntro:
      '以下の各ページでは、1つの通貨ペアについて、両方の通貨の変わりにくい事実をまとめています。',
    editionsHeading: 'どの版をインストールするか',
    editionFree: 'Android — 無料版',
    editionPro: 'Android — Pro 版',
    editionIos: 'iOS',
    editionFreeNote: '換算機能はすべて使え、広告で運営しています。',
    editionProNote: '機能は同じで、広告がありません。',
    editionIosNote: 'iPhone と iPad に対応し、ウィジェットも使えます。',
    supportedHeading: '{{app}} が対応する通貨の一覧',
    supportedIntro:
      '以下の一覧はアプリ自身の通貨カタログから読み出したもので、丸めた宣伝上の数字ではなく、実際に同梱されている通貨そのものです。コードにカーソルを合わせると通貨名が出ます。',
    languagesHeading: '他の言語の通貨ページ',
  },
},

  ko: {

  /**
   * Official names of the issuing central banks in this language. Only the ones
   * this locale's pairs actually use are listed; anything absent falls back to
   * the English name in tools/lib/currency-facts.mjs, which is correct for
   * institutions whose name is not normally translated.
   */
  banks: {
    USD: "연방준비제도",
    KRW: "한국은행",
    JPY: "일본은행",
    EUR: "유럽중앙은행",
    VND: "베트남 국가은행",
    CNY: "중국인민은행",
    THB: "태국은행",
    TWD: "중화민국 중앙은행",
    PHP: "필리핀 중앙은행",
    GBP: "잉글랜드은행",
    AUD: "호주 준비은행",
    HKD: "홍콩금융관리국",
    SGD: "싱가포르 통화청",
  },
  languageName: '한국어',

  ui: {
    home: '홈',
    hubBreadcrumb: '환율 계산기',
    convert: '환산',
    source: '출처',
    otherLanguages: '이 페이지를 다른 언어로 보기',
    relatedPairs: '관련 통화 쌍',
    allPairs: '전체 통화 쌍 보기',
    getTheApp: '{{app}} 설치하기',
    playBadge: 'Google Play에서 {{app}} 받기',
    appleBadge: 'App Store에서 {{app}} 받기',
    screenshotsAlt: '{{app}} 화면: ',
    screenHome: '환산기 첫 화면',
    screenChart: '환율 추이 차트 화면',
    screenSelect: '검색이 되는 통화 선택 화면',
    factsHeading: '두 통화를 나란히 놓고 보기',
    factCode: 'ISO 4217 코드',
    factSymbol: '기호',
    factMinor: '보조 단위 자릿수 (ISO 4217 지수)',
    factBank: '발행 중앙은행',
    factRegion: '통용 지역',
    howToHeading: '{{app}}에서 {{base}} → {{quote}} 환산하는 방법',
    faqHeading: '{{base}} → {{quote}} 환율 자주 묻는 질문',
    author: 'Julien Millau가 만들고 발행합니다. 안드로이드와 iOS를 혼자 개발하는 1인 개발자입니다.',
    disclaimer:
      '참고용 정보이며 정보 제공 목적으로만 싣습니다. 투자 조언이 아니고, 어떤 거래에도 그대로 적용되는 조건이 아닙니다.',
    privacy: '개인정보 처리방침',
    terms: '이용약관',
    contact: '문의',
    currencyBasket: '여러 통화로 구성된 바스켓',
  },

  /** 전각 30단위 / 80단위 예산. 코드가 3글자로 펼쳐진 뒤에도 넘지 않아야 합니다. */
  meta: {
    titlePair: '{{base}} {{quote}} 환율 계산기·오프라인',
    descPair:
      '{{base}} {{quote}}: 두 통화의 발행 주체와 환율을 움직이는 요인. 환산은 무료 오프라인 앱.',
    titleHub: '무료 환율 계산기 – 180개 통화',
    descHub:
      '180개 이상 통화와 20종 암호화폐를 온·오프라인에서 환산. 안드로이드·iOS 무료.',
  },

  pair: {
    h1: '{{baseName}} → {{quoteName}} 환율 계산 ({{base}}/{{quote}})',

    lead:
      '{{baseName}}({{base}}) 금액을 {{quoteName}}({{quote}}) 금액으로 바꾸는 계산은 안드로이드와 iOS에서 무료로 쓰는 {{app}}가 하고, 연결이 끊겨도 마지막으로 저장해 둔 환율로 이어집니다. '
      + '이 페이지가 다루는 것은 통화 쌍 그 자체입니다. 두 통화가 각각 어떤 돈이고 어느 중앙은행이 발행하며, 둘 사이의 환율을 실제로 움직이는 것이 무엇인지 정리했습니다.',

    factsIntro: '통화 쌍 양쪽의 기본 정보입니다. 환율과 달리 몇 년 단위로만 바뀌는 값들입니다.',

    pegBlock:
      '{{quoteName}}({{quote}}) 환율은 {{pegAgainst}} 대비로 자유롭게 움직이지 않습니다. {{pegSince}}년부터 고정되어 있기 때문입니다. '
      + '그래서 {{base}}/{{quote}} 참고 환율은 거의 움직이지 않고, 차트를 그려도 평평한 선에 가깝습니다. '
      + '정작 달라지는 것은 손에 쥐는 금액입니다. 은행과 카드사, 환전소가 고정된 환율 위에 각자의 마진을 얹기 때문에, 똑같이 "공식 환율"이라고 말하면서도 내주는 금액은 서로 다릅니다.',

    /**
     * 한쪽 통화가 '제3의 통화'에 고정된 쌍에서 씁니다.
     * 이런 쌍에 "두 통화 모두 시장에서 정해진다"고 쓰면 사실과 다릅니다.
     */
    anchoredBlock:
      '연동 관계부터 정리하면 이렇습니다. {{pegName}}({{pegCode}}) 환율은 {{pegAnchorName}}에 묶여 있고, {{floatName}}({{floatCode}})에 묶인 것이 아닙니다. '
      + '그래서 {{base}}/{{quote}} 환율은 사실상 {{floatCode}} 쪽에서만 움직입니다. 이 쌍의 숫자가 달라졌다면 움직인 쪽은 {{floatName}}입니다. '
      + '{{base}}/{{quote}} 차트도 결국 {{pegAnchorName}} 대비 {{floatCode}} 차트에 가깝고, 며칠에서 몇 주 정도의 짧은 구간에서는 환율이 움직인 폭보다 은행이나 환전소가 얹는 마진이 실제 비용에서 더 큰 몫을 차지합니다.',

    floatBlock:
      '두 통화 모두 시장에서 가격이 정해지므로 {{base}}/{{quote}} 환율은 고정값이 아닙니다. '
      + '방향을 크게 좌우하는 것은 두 발행 중앙은행의 통화정책 결정입니다. {{base}} 쪽은 {{baseBank}}, {{quote}} 쪽은 {{quoteBank}}입니다. '
      + '어떤 정적인 페이지도 환율을 숫자로 박아 두고 계속 맞을 수 없는 이유가 여기에 있습니다.',

    howto: [
      '{{base}} 금액을 입력합니다.',
      '통화 목록에서 {{quoteName}}({{quote}}) 항목을 고릅니다. 나라 이름, 통화 이름, ISO 코드 중 아무거나로 검색됩니다.',
      '환산된 {{quote}} 금액을 눌러 복사하거나 공유합니다.',
      '{{base}}/{{quote}} 쌍을 즐겨찾기에 고정해 한 번에 불러옵니다.',
    ],

    offline:
      '{{app}}는 마지막으로 내려받은 환율을 기기에 저장하기 때문에 비행기 안, 지하철, 로밍을 꺼 둔 해외에서도 {{base}} → {{quote}} 환산이 그대로 됩니다. 저장된 환율에는 받아 온 시각이 함께 남아, 지금 보고 있는 숫자가 언제 것인지 늘 확인할 수 있습니다.',

    faqAlways: [
      {
        q: '{{app}}는 {{base}}/{{quote}} 환율을 어디에서 받아 오나요?',
        a: '금융 데이터 제공처에서 받아 오고, 기기가 연결되어 있으면 하루에 여러 차례 새로 내려받습니다. {{app}}는 갱신할 때마다 받아 온 시각을 함께 남기므로, 화면에 떠 있는 숫자가 언제 것인지 늘 확인할 수 있습니다.',
      },
      {
        q: '{{app}}가 보여 주는 환율에 은행 수수료가 들어 있나요?',
        a: '들어 있지 않습니다. {{app}}가 쓰는 값은 은행 간 거래에 가까운 참고 환율이고, 은행과 카드사, 환전소가 그 위에 각자 마진을 얹습니다. 그래서 같은 {{base}} 금액으로 실제로 손에 쥐는 {{quote}} 금액은 그보다 적습니다.',
      },
    ],

    faqRotating: [
      {
        q: '{{app}}는 인터넷 없이도 {{base}} → {{quote}} 환산이 되나요?',
        a: '됩니다. {{app}}는 마지막으로 내려받은 환율을 기기에 저장해 두고 연결 없이도 계속 환산하며, 그 환율을 언제 받아 왔는지 날짜를 함께 보여 줍니다.',
      },
      {
        q: '{{app}}는 {{base}}/{{quote}} 환율을 얼마나 자주 갱신하나요?',
        a: '기기가 연결될 때마다 금융 데이터 제공처에서 하루에 여러 차례 새로 받아 옵니다. 마지막으로 갱신한 시점은 앱 화면에 그대로 표시됩니다.',
      },
      {
        q: '{{app}}는 무료인가요?',
        a: '무료입니다. 안드로이드와 iOS에서 계정도 로그인도 없이 설치해 쓸 수 있습니다. 무료판은 광고로 운영되고, Pro 버전은 그 광고를 없앤 것입니다.',
      },
    ],

    relatedIntro: '이 사이트에서 다루는 다른 {{base}} · {{quote}} 환산 페이지입니다.',
  },

  hub: {
    h1: '환율 계산기 앱',
    lead:
      '{{app}}는 180개가 넘는 세계 통화와 20종 이상의 암호화폐를 서로 바꿔 볼 수 있는 무료 환율 계산기이며, 안드로이드와 iOS에서 모두 씁니다. '
      + '환율은 하루에 여러 차례 새로 받아 오고, 1일에서 5년까지 이어지는 추이 차트를 그리며, 연결이 끊기면 마지막으로 저장해 둔 환율로 계산을 이어갑니다. 계정도 로그인도 필요 없습니다.',
    featuresHeading: '{{app}}가 하는 일',
    features: [
      '180개가 넘는 세계 통화. 나라 이름, 통화 이름, ISO 4217 코드 중 아무거나로 검색',
      'Bitcoin(BTC), Ethereum(ETH)을 비롯한 20종 이상의 암호화폐 시세',
      '금융 데이터 제공처에서 하루 여러 차례 새로 받아 오는 환율',
      '연결이 없을 때 마지막 저장 환율로 그대로 쓰는 완전 오프라인 환산, 저장 시각 함께 표시',
      '1일에서 5년까지 이어지는 환율 추이 차트',
      '홈 화면 위젯, 직접 구성하는 즐겨찾기 목록',
      '소수점 자릿수는 직접 정하고, 환산 결과는 한 번 눌러 복사',
      '계정도 로그인도 필요 없이 설치하고 바로 환산',
    ],
    pairsHeading: '한국어로 제공하는 통화 쌍',
    pairsIntro:
      '아래 각 페이지는 통화 쌍 하나를 다루며, 두 통화의 기본 정보를 함께 싣고 있습니다.',
    editionsHeading: '어느 버전을 설치할까',
    editionFree: '안드로이드 — 무료',
    editionPro: '안드로이드 — Pro',
    editionIos: 'iOS',
    editionFreeNote: '환산 기능은 모두 같고 광고가 표시됩니다.',
    editionProNote: '같은 기능에 광고만 없습니다.',
    editionIosNote: '아이폰과 아이패드에서 쓰며 위젯을 지원합니다.',
    supportedHeading: '{{app}}가 지원하는 통화 전체',
    supportedIntro:
      '아래 목록은 {{app}}에 실제로 들어 있는 통화 목록을 그대로 읽어 온 것이라, 반올림한 홍보 숫자가 아니라 진짜로 담겨 있는 통화입니다. 코드 위에 마우스를 올리면 통화 이름이 나옵니다.',
    languagesHeading: '다른 언어로 보는 통화 페이지',
  },
},

  zh: {

  /**
   * Official names of the issuing central banks in this language. Only the ones
   * this locale's pairs actually use are listed; anything absent falls back to
   * the English name in tools/lib/currency-facts.mjs, which is correct for
   * institutions whose name is not normally translated.
   */
  banks: {
    USD: "美国联邦储备系统",
    CNY: "中国人民银行",
    JPY: "日本银行",
    HKD: "香港金融管理局",
    KRW: "韩国银行",
    EUR: "欧洲中央银行",
    TWD: "中华民国中央银行",
    THB: "泰国银行",
    GBP: "英格兰银行",
    AUD: "澳大利亚储备银行",
    SGD: "新加坡金融管理局",
    CAD: "加拿大银行",
    MYR: "马来西亚国家银行",
  },
  /** 在其他语言版本的语言切换器里显示的语言名。 */
  languageName: '简体中文',

  ui: {
    home: '首页',
    hubBreadcrumb: '汇率换算',
    otherLanguages: '本页的其他语言版本',
    relatedPairs: '相关货币对',
    allPairs: '查看全部货币对',
    getTheApp: '获取 {{app}}',
    playBadge: '在 Google Play 上获取 {{app}}',
    appleBadge: '在 App Store 上获取 {{app}}',
    screenshotsAlt: '{{app}} 界面：',
    screenHome: '换算主界面',
    screenChart: '历史汇率走势图',
    screenSelect: '可搜索的货币列表',
    factsHeading: '两种货币的基础资料对照',
    factCode: 'ISO 4217 代码',
    factSymbol: '货币符号',
    factMinor: '辅币位数（ISO 4217 指数）',
    factBank: '发行的中央银行',
    factRegion: '发行地区',
    howToHeading: '在 {{app}} 里把 {{base}} 换算成 {{quote}}',
    faqHeading: '关于 {{base}} 兑 {{quote}} 的常见问题',
    author: '由独立 Android 与 iOS 开发者 Julien Millau 发布。',
    disclaimer:
      '本页内容仅为参考资料。不构成任何投资建议，也不等于任何一笔交易的成交价格。',
    privacy: '隐私政策',
    terms: '使用条款',
    contact: '联系方式',
    currencyBasket: '一篮子货币',
  },

  /** 全角字符按两个单位计。标题不超过 30，描述不超过 80。 */
  meta: {
    titlePair: '{{base}}兑{{quote}}换算器 汇率与离线应用',
    descPair:
      '{{base}}兑{{quote}}：两种货币的来历与发行方，以及什么在推动汇率。换算由免费应用离线完成。',
    titleHub: '汇率换算器 180种货币 支持离线',
    descHub:
      '180多种货币与20多种加密货币换算，在线离线均可用，附5年走势图，免费无需注册。',
  },

  pair: {
    h1: '把 {{base}} 换算成 {{quote}}',

    /**
     * 没有写路线段落的货币对才会用到这一段。
     * 结论先行，第一句单独摘出来也要能读懂：换算在应用里做，页面负责讲清楚这对货币。
     */
    lead:
      '把{{baseName}}（{{base}}）换算成{{quoteName}}（{{quote}}），请用 {{app}} —— 一款免费的 Android 与 iOS 应用，断网时靠最后保存的汇率照样能算。'
      + '本页不做换算，它是这个货币对本身的资料：两种货币各自是什么、由哪家中央银行发行，以及真正推动两者比价的是什么。',

    factsIntro: '下面这些是两种货币各自比较稳定的资料，以年为单位才会变化，和随时波动的汇率不同。',

    pegBlock:
      '{{quoteName}}（{{quote}}）对{{pegAgainst}}并不是自由浮动的：自 {{pegSince}} 年起，它被维持在固定的水平上。'
      + '所以 {{base}}/{{quote}} 的参考汇率几乎不动，把它画成走势图，基本上就是一条平线。'
      + '真正会变的是您最后拿到手的金额。银行、卡组织和货币兑换店都会在这个水平之上加自己的点差，因此两家都说自己「按官方汇率」的柜台，给出的钱可以差一截。',

    /**
     * 用于其中一方盯住「第三种货币」的货币对。这类页面上写「两种货币都是浮动的」
     * 就是事实错误，所以单独给一段。
     */
    anchoredBlock:
      '{{pegName}}（{{pegCode}}）盯住的是{{pegAnchorName}}，而不是{{floatName}}。'
      + '所以 {{base}}/{{quote}} 的汇率几乎全部由 {{floatCode}} 这一边推动：这个数字动了，动的是{{floatName}}。'
      + '把 {{base}}/{{quote}} 画成走势图，看到的其实是 {{floatCode}} 对{{pegAnchorName}}的走势。'
      + '而在几天到几周这样的短周期里，银行或兑换店加的点差，往往比汇率本身的变动更能决定您最后拿到多少钱。',

    /**
     * 央行名会展开成中文（{{baseBank}} → 中国人民银行），所以两个占位符都放在
     * 冒号之后、用顿号隔开，句子本身不依赖它们的字数、开头或结尾。
     */
    floatBlock:
      '{{base}}/{{quote}} 没有官方定死的比价，价格由市场供求定出来，所以每天都在动。'
      + '推着它走的主要是两边的利差，以及各自货币当局的政策取向：{{baseBank}}、{{quoteBank}}。'
      + '这也是为什么任何一个把汇率写死在正文里的静态页面，隔天就是错的。',

    howto: [
      '输入 {{base}} 金额。',
      '选择{{quoteName}}（{{quote}}），可以按国家名、货币名或 ISO 代码搜索。',
      '点一下换算出来的 {{quote}} 数字，即可复制或分享。',
      '把 {{base}}/{{quote}} 加入收藏，下次打开一眼就能看到。',
    ],

    offline:
      '{{app}} 会把下载过的汇率存在手机本地，所以在飞机上、地铁里，或者在境外关掉数据漫游的时候，{{base}} 兑 {{quote}} 的换算照样能用。保存下来的汇率带着获取时间，您随时知道手里这个数字是什么时候的。',

    /**
     * 每一页都会出现的两个问题，也是别人很少老实回答的两个。
     * 答案要和 FAQPage 的 JSON-LD 一字不差，所以只在这里写一次。
     */
    faqAlways: [
      {
        q: '{{app}} 的 {{base}}/{{quote}} 汇率是从哪里来的？',
        a: '来自金融数据提供商。只要设备连着网，{{app}} 每天会取好几次，并给每一次更新打上时间戳，所以您随时知道屏幕上这个数字是什么时候的。',
      },
      {
        q: '这个汇率里包含银行手续费吗？',
        a: '不包含。{{app}} 给出的是银行同业之间的参考汇率。银行、卡组织和兑换店各自还要在这之上加点差，所以您拿 {{base}} 实际换到的 {{quote}} 会更少。',
      },
    ],

    /** 每页只显示其中一个，按货币对确定性地选出。 */
    faqRotating: [
      {
        q: '{{app}} 没有网络时还能把 {{base}} 换成 {{quote}} 吗？',
        a: '能。{{app}} 把最后一次下载的汇率存在手机本地，断网后照样换算，同时显示这批汇率是什么时候取回来的。',
      },
      {
        q: '{{app}} 多久刷新一次 {{base}}/{{quote}} 汇率？',
        a: '每天好几次。设备一有连接，{{app}} 就向金融数据提供商取一次新的，并在界面上标出最后一次刷新的时间。',
      },
      {
        q: '{{app}} 是免费的吗？',
        a: '免费。在 Android 和 iOS 上都能免费装，不用注册账号，也不用登录。免费版靠广告支持，Pro 版去掉广告。',
      },
    ],

    relatedIntro: '本站还写了这些与 {{base}}、{{quote}} 有关的换算页面：',
  },

  hub: {
    h1: '汇率换算应用',
    lead:
      '{{app}} 是一款免费的汇率换算应用，支持 Android 和 iOS，可以在 180 多种法定货币和 20 多种加密货币之间换算。'
      + '汇率每天刷新多次，走势图可以从 1 天一直看到 5 年，没有网络的时候用最后保存的汇率继续算。'
      + '不用注册账号，也不用登录。',
    featuresHeading: '{{app}} 能做什么',
    features: [
      '支持 180 多种法定货币，可按国家名、货币名或 ISO 4217 代码搜索',
      '支持 20 多种加密货币，包括比特币（BTC）和以太坊（ETH）',
      '汇率来自金融数据提供商，每天刷新多次',
      '完整离线换算：断网时用最后保存的汇率，并显示这批数据的获取时间',
      '1 天、1 周、1 个月、1 年、5 年五档历史走势图',
      '桌面小组件，以及可以自己排序的收藏货币列表',
      '小数位数自己设定，换算结果一键复制',
      '不用注册账号，不用登录——装上就能换算',
    ],
    pairsHeading: '已推出中文版的货币对',
    pairsIntro:
      '下面每一页只讲一个货币对，写给住在中国内地以外的中文读者：香港、台湾、新加坡、马来西亚，'
      + '以及在美、日、韩、欧、英、澳、加、泰读书和工作的人。手里是当地货币，心里算的是人民币。'
      + '每页都有两种货币各自的稳定资料，以及这条路线上真正容易吃亏的地方。',
    editionsHeading: '该装哪个版本',
    editionFree: 'Android 免费版',
    editionPro: 'Android Pro 版',
    editionIos: 'iOS',
    editionFreeNote: '换算功能全都有，靠广告支持。',
    editionProNote: '功能一样，没有广告。',
    editionIosNote: '支持 iPhone 和 iPad，可用桌面小组件。',
    supportedHeading: '{{app}} 支持的全部货币',
    supportedIntro:
      '下面这份清单直接读自应用自带的货币目录，是实际装进应用里的货币，而不是宣传口径上取整的数字。把鼠标停在代码上可以看到货币名称。',
    languagesHeading: '其他语言的汇率页面',
  },
},

  hi: {

  /**
   * Official names of the issuing central banks in this language. Only the ones
   * this locale's pairs actually use are listed; anything absent falls back to
   * the English name in tools/lib/currency-facts.mjs, which is correct for
   * institutions whose name is not normally translated.
   */
  banks: {
    INR: "भारतीय रिज़र्व बैंक",
    USD: "अमेरिकी फ़ेडरल रिज़र्व",
    EUR: "यूरोपीय केंद्रीय बैंक",
    GBP: "बैंक ऑफ़ इंग्लैंड",
    AED: "संयुक्त अरब अमीरात का केंद्रीय बैंक",
    SAR: "सऊदी केंद्रीय बैंक",
    QAR: "क़तर केंद्रीय बैंक",
    KWD: "कुवैत का केंद्रीय बैंक",
    CAD: "बैंक ऑफ़ कनाडा",
    AUD: "ऑस्ट्रेलियाई रिज़र्व बैंक",
    SGD: "सिंगापुर मौद्रिक प्राधिकरण",
    NPR: "नेपाल राष्ट्र बैंक",
    // "नेगारा" मलय में "राष्ट्र" है, पर संस्था का नाम हिन्दी में अनूदित नहीं,
    // लिप्यंतरित होता है — देवनागरी वाक्य के बीच लातिनी नाम ही खटकता है।
    MYR: "बैंक नेगारा मलेशिया",
  },
  /** Language name shown in the switcher of *other* locales. */
  languageName: 'Hindi',

  ui: {
    home: 'होम',
    hubBreadcrumb: 'करेंसी कन्वर्टर',
    convert: 'बदलें',
    source: 'स्रोत',
    otherLanguages: 'यह पेज दूसरी भाषाओं में',
    relatedPairs: 'मिलती-जुलती करेंसी जोड़ियाँ',
    allPairs: 'सभी करेंसी जोड़ियाँ',
    getTheApp: '{{app}} इंस्टॉल करें',
    playBadge: 'Google Play पर {{app}}',
    appleBadge: 'App Store पर {{app}}',
    screenshotsAlt: '{{app}} की स्क्रीन: ',
    screenHome: 'कन्वर्टर की मुख्य स्क्रीन',
    screenChart: 'पुराने रेट का चार्ट',
    screenSelect: 'खोज के साथ करेंसी चुनने की स्क्रीन',
    factsHeading: 'दोनों मुद्राएँ आमने-सामने',
    factCode: 'ISO 4217 कोड',
    factSymbol: 'चिह्न',
    factMinor: 'छोटी इकाई (ISO 4217 घातांक)',
    factBank: 'जारी करने वाला केंद्रीय बैंक',
    factRegion: 'किसके लिए जारी',
    howToHeading: '{{app}} में {{base}} से {{quote}} कैसे बदलें',
    faqHeading: '{{base}} और {{quote}} के बारे में आम सवाल',
    author: 'प्रकाशक: जूलियन मियो, स्वतंत्र Android और iOS डेवलपर।',
    disclaimer:
      'यहाँ दी गई जानकारी सिर्फ़ संदर्भ के लिए है। यह निवेश सलाह नहीं है, और न ही किसी सौदे के लिए दिया गया भाव।',
    privacy: 'गोपनीयता नीति',
    terms: 'उपयोग की शर्तें',
    contact: 'संपर्क',
    currencyBasket: 'मुद्राओं की एक टोकरी',
  },

  /** शीर्षक ≤ 60 इकाई, विवरण ≤ 158 इकाई। नाम का पूँछ-वाला ब्रांड सफ़िक्स नहीं। */
  meta: {
    titlePair: '{{base}} से {{quote}} रेट – करेंसी कन्वर्टर ऐप',
    descPair:
      '{{base}} और {{quote}}: दोनों मुद्राएँ क्या हैं, कौन जारी करता है, भाव किससे हिलता है। बदलने का काम {{app}} में — मुफ़्त, ऑफ़लाइन भी।',
    titleHub: 'करेंसी कन्वर्टर ऐप – 180+ मुद्राएँ, ऑफ़लाइन भी',
    descHub:
      '180+ विश्व मुद्राएँ और 20+ क्रिप्टो, इंटरनेट के साथ या बिना, एक दिन से पाँच साल तक के चार्ट के साथ बदलें। Android और iOS पर मुफ़्त, बिना अकाउंट।',
  },

  pair: {
    h1: '{{base}} से {{quote}} में बदलें',

    /**
     * बैकअप भूमिका: जिस जोड़ी का अपना लिखा हुआ हिस्सा न हो, वहाँ यही दिखती है।
     * पेज ख़ुद कुछ नहीं बदलता, इसलिए पहला ही वाक्य बता देता है कि हिसाब कहाँ
     * होता है — और बाक़ी पेज किस काम आता है।
     *
     * मुद्रा के नाम कोलन के बाद, बिना परसर्ग के रखे गए हैं। "रुपया में" जैसा
     * टूटा रूप तभी बनता है जब परसर्ग सीधे बदलते हुए नाम पर लगे — "रुपये में"
     * और "डॉलर में" एक ही साँचे से नहीं निकल सकते, इसलिए साँचा ही बदला है।
     */
    lead:
      '{{baseName}} ({{base}}) को {{quoteName}} ({{quote}}) में {{app}} बदलता है — Android और iOS पर मुफ़्त ऐप, जो बिना नेटवर्क भी चलता रहता है। '
      + 'यह पेज ख़ुद जोड़ी की जानकारी के लिए है: दोनों मुद्राएँ क्या हैं, उन्हें कौन सा केंद्रीय बैंक जारी करता है, और उनके बीच का भाव असल में किन वजहों से हिलता है।',

    factsIntro: 'दोनों मुद्राओं की टिकाऊ जानकारी — रेट के उलट, ये बातें सालों के पैमाने पर बदलती हैं।',

    pegBlock:
      '{{base}} खुले बाज़ार में तैरने वाली मुद्रा नहीं है: {{pegSince}} से इसका मूल्य एक तय लंगर के साथ बाँधकर रखा जाता है, रोज़ के सौदों से नहीं। '
      + 'इसलिए इस जोड़ी में असली सवाल "आज रेट क्या है" नहीं, बल्कि "मेरे हाथ में कितना आया" होना चाहिए। '
      + 'बैंक, मनी एक्सचेंज काउंटर और कार्ड नेटवर्क इसी तय संदर्भ के ऊपर अपना मार्जिन जोड़ते हैं, और वही मार्जिन दो जगहों के बीच का पूरा फ़र्क़ बनाता है — दोनों "सरकारी रेट" का नाम लेकर आपको अलग-अलग रकम थमा सकती हैं।',

    /**
     * जब एक मुद्रा किसी तीसरी मुद्रा से बँधी हो — इन 18 पेजों पर "दोनों मुद्राएँ
     * तैरती हैं" लिखना सीधा-सीधा ग़लत होता। KWD की टोकरी की बनावट प्रकाशित नहीं है,
     * इसलिए यहाँ कोई तय आँकड़ा नहीं दिया जाता।
     *
     * {{pegAnchorName}} कभी मुद्रा का नाम होता है और कभी "मुद्राओं की एक टोकरी" —
     * इसलिए वह हर बार वाक्य के आख़िर में, कोलन के बाद बैठता है। "हिलने वाला
     * {{floatName}} होता है" जैसी बनावट यहाँ नहीं चल सकती: उसका लिंग नाम के साथ
     * बदलता है, और साँचा एक ही रहता है।
     */
    anchoredBlock:
      'इस जोड़ी की एक टाँग बँधी हुई है — {{pegName}} ({{pegCode}}) — और उसका लंगर एक तय संदर्भ है: {{pegAnchorName}}। दूसरी टाँग खुली है: {{floatName}} ({{floatCode}})। '
      + 'इसलिए {{base}}/{{quote}} में हलचल लगभग पूरी तरह {{floatCode}} की तरफ़ से आती है — यह जोड़ी जब हिलती है, तब हिलने वाली यही टाँग होती है। '
      + '{{base}}/{{quote}} का चार्ट देखना असल में {{floatCode}} का चार्ट देखना है, और उसका दूसरा सिरा हर बार वही रहता है: {{pegAnchorName}}। '
      + 'कुछ दिनों के पैमाने पर बैंक या एक्सचेंज काउंटर का जोड़ा हुआ मार्जिन आपकी लागत में रेट से बड़ा हिस्सा बनता है।',

    floatBlock:
      '{{base}}/{{quote}} का रेट किसी घोषणा से नहीं, बाज़ार के सौदों से बनता है — इसमें {{baseBank}} और {{quoteBank}} की नीतियाँ, कच्चे तेल का भाव और विदेशी पूँजी का आना-जाना, सब हिस्सा डालते हैं। '
      + 'यही वजह है कि कोई भी स्थिर पेज रेट छापकर सही नहीं रह सकता।',

    howto: [
      '{{base}} में रकम लिखें।',
      'सूची में {{quoteName}} ({{quote}}) ढूँढ़ें — खोज में मुल्क, करेंसी या ISO कोड, तीनों चलते हैं।',
      '{{quote}} वाले नतीजे पर टैप करके उसे कॉपी या साझा करें।',
      '{{base}}/{{quote}} को पसंदीदा में लगा लें, ताकि हर बार एक टैप में खुले।',
    ],

    offline:
      '{{app}} आख़िरी डाउनलोड किए गए रेट फ़ोन में ही सहेज लेता है, इसलिए {{base}} से {{quote}} का हिसाब हवाई जहाज़ में, मेट्रो में, या रोमिंग बंद रखकर विदेश में भी चलता रहता है। सहेजे गए रेट के साथ तारीख़ भी रहती है, तो आपको हमेशा पता रहता है कि आँकड़ा कितना पुराना है।',

    /**
     * हर पेज पर दिखने वाले दो सवाल, जिनका सीधा जवाब कम मिलता है।
     * जवाब FAQPage JSON-LD में हूबहू जाते हैं, इसलिए यहीं एक बार लिखे हैं।
     */
    faqAlways: [
      {
        q: '{{app}} में {{base}}/{{quote}} का भाव कहाँ से आता है?',
        a: 'वित्तीय डेटा देने वाली कंपनियों से। जब भी फ़ोन को नेटवर्क मिलता है, आँकड़ा दिन में कई बार ताज़ा हो जाता है, और {{app}} हर अपडेट के साथ उसका समय भी दर्ज करता है — यानी स्क्रीन पर दिख रहा आँकड़ा कितना पुराना है, यह हमेशा सामने रहता है।',
      },
      {
        q: 'क्या उस भाव में मेरे बैंक का चार्ज शामिल होता है?',
        a: 'नहीं। {{app}} अंतर-बैंक संदर्भ भाव दिखाता है। बैंक, कार्ड नेटवर्क और मनी एक्सचेंज अपना मार्जिन उसके ऊपर से जोड़ते हैं, इसलिए आपकी {{base}} रकम के बदले {{quote}} में जो हाथ आएगा, वह उससे कम बैठेगा।',
      },
    ],

    /** हर पेज पर इनमें से एक, जोड़ी के नाम से तय होकर। */
    faqRotating: [
      {
        q: 'क्या {{app}} बिना इंटरनेट के {{base}} से {{quote}} बदल देता है?',
        a: 'हाँ। {{app}} आख़िरी डाउनलोड किए गए भाव फ़ोन में ही सहेज लेता है और बिना नेटवर्क के भी हिसाब लगाता रहता है, साथ में यह तारीख़ भी दिखाता है कि वह आँकड़ा कब का है।',
      },
      {
        q: '{{app}} {{base}}/{{quote}} का भाव कितनी बार बदलता है?',
        a: 'दिन में कई बार। फ़ोन जब भी इंटरनेट से जुड़ता है, ऐप ताज़ा आँकड़ा उतार लेता है, और आख़िरी बार वह कब आया था यह {{app}} में लिखा रहता है।',
      },
      {
        q: 'क्या {{app}} मुफ़्त है?',
        a: 'हाँ, Android तथा iOS दोनों पर मुफ़्त इंस्टॉल होता है — न अकाउंट चाहिए, न साइन-इन। मुफ़्त संस्करण विज्ञापन के सहारे चलता है, और Pro संस्करण में विज्ञापन नहीं आते।',
      },
    ],

    relatedIntro: '{{base}} और {{quote}} से जुड़े बाक़ी हिसाब, जो इस साइट पर मौजूद हैं:',
  },

  hub: {
    h1: 'करेंसी कन्वर्टर ऐप',
    lead:
      '{{app}} एक मुफ़्त करेंसी कन्वर्टर है, Android और iOS दोनों के लिए, जिसमें 180+ विश्व मुद्राएँ और 20+ क्रिप्टोकरेंसी एक ही सूची में मिलती हैं। '
      + 'रेट दिन में कई बार ताज़ा होते हैं, एक दिन से पाँच साल तक के चार्ट बनते हैं, और नेटवर्क न होने पर आख़िरी सहेजे गए रेट से हिसाब चलता रहता है। न अकाउंट बनाना पड़ता है, न साइन-इन करना पड़ता है।',
    featuresHeading: '{{app}} क्या-क्या करता है',
    features: [
      '180+ विश्व मुद्राएँ, जिन्हें मुल्क, करेंसी या ISO 4217 कोड — तीनों तरह से खोजा जा सकता है',
      '20+ क्रिप्टोकरेंसी, जिनमें Bitcoin (BTC) और Ethereum (ETH) शामिल हैं',
      'वित्तीय डेटा देने वालों से रेट दिन में कई बार ताज़ा',
      'बिना नेटवर्क पूरा हिसाब, आख़िरी सहेजे गए रेट और उनकी तारीख़ के साथ',
      'एक दिन से पाँच साल तक के पुराने रेट के चार्ट',
      'होम स्क्रीन विजेट और अपने हिसाब से बनाई पसंदीदा सूची',
      'दशमलव के बाद कितने अंक दिखें यह आप तय करें, नतीजा एक टैप में कॉपी',
      'न अकाउंट, न साइन-इन — इंस्टॉल कीजिए और हिसाब लगाइए',
    ],
    pairsHeading: 'हिन्दी में शामिल करेंसी जोड़ियाँ',
    pairsIntro:
      'नीचे का हर पेज एक जोड़ी पर है: दोनों मुद्राओं की टिकाऊ जानकारी, भाव किन वजहों से हिलता है, और {{app}} में उसे कैसे बदला जाए।',
    editionsHeading: 'कौन सा संस्करण लगाएँ',
    editionFree: 'Android — मुफ़्त',
    editionPro: 'Android — Pro',
    editionIos: 'iOS',
    editionFreeNote: 'हिसाब की सारी सुविधाएँ, विज्ञापन के सहारे।',
    editionProNote: 'वही ऐप, बिना विज्ञापन के।',
    editionIosNote: 'iPhone और iPad, विजेट के साथ।',
    supportedHeading: '{{app}} में मौजूद हर मुद्रा',
    supportedIntro:
      'नीचे की पूरी सूची ऐप की अपनी सूची से पढ़ी गई है, यानी यह वही है जो ऐप में सचमुच है, कोई गोल-मटोल विज्ञापनी आँकड़ा नहीं। किसी कोड पर कर्सर ले जाकर मुद्रा का नाम देखा जा सकता है।',
    languagesHeading: 'दूसरी भाषाओं में करेंसी पेज',
  },
},

  ar: {

  /**
   * Official names of the issuing central banks in this language. Only the ones
   * this locale's pairs actually use are listed; anything absent falls back to
   * the English name in tools/lib/currency-facts.mjs, which is correct for
   * institutions whose name is not normally translated.
   */
  banks: {
    USD: "نظام الاحتياطي الفيدرالي",
    EGP: "البنك المركزي المصري",
    SAR: "البنك المركزي السعودي",
    AED: "مصرف الإمارات المركزي",
    INR: "بنك الاحتياطي الهندي",
    MAD: "بنك المغرب",
    DZD: "بنك الجزائر",
    TND: "البنك المركزي التونسي",
    KWD: "بنك الكويت المركزي",
    EUR: "البنك المركزي الأوروبي",
  },
  /** Language name shown in the switcher of *other* locales. */
  languageName: 'العربية',

  ui: {
    home: 'الرئيسية',
    hubBreadcrumb: 'محوّل العملات',
    convert: 'حوّل',
    source: 'المصدر',
    otherLanguages: 'هذه الصفحة بلغات أخرى',
    relatedPairs: 'أزواج عملات ذات صلة',
    allPairs: 'كل أزواج العملات',
    getTheApp: 'حمّل {{app}}',
    playBadge: '{{app}} على Google Play',
    appleBadge: '{{app}} على App Store',
    screenshotsAlt: 'من شاشات {{app}}: ',
    screenHome: 'الشاشة الرئيسية للمحوّل',
    screenChart: 'مخطط تاريخي لسعر الصرف',
    screenSelect: 'قائمة العملات مع خانة بحث',
    factsHeading: 'العملتان جنبًا إلى جنب',
    factCode: 'رمز ISO 4217',
    factSymbol: 'الرمز',
    factMinor: 'الوحدة الفرعية (أُسّ ISO 4217)',
    factBank: 'البنك المركزي المُصدِر',
    factRegion: 'تُصدَر لصالح',
    howToHeading: 'كيف تحوّل {{base}} إلى {{quote}} داخل {{app}}',
    faqHeading: 'أسئلة عن تحويل {{base}} إلى {{quote}}',
    author: 'نشرها جوليان ميّو، مطوّر مستقل لتطبيقات أندرويد وiOS.',
    disclaimer:
      'معلومات مرجعية للاطّلاع فقط. ليست نصيحة مالية ولا عرض سعر لتنفيذ أي معاملة.',
    privacy: 'سياسة الخصوصية',
    terms: 'شروط الاستخدام',
    contact: 'للتواصل',
    currencyBasket: 'سلة من العملات',
  },

  /** ≤ 60 حرفًا بعد استبدال الرموز. بلا لاحقة اسم شخصي. */
  meta: {
    titlePair: 'تحويل {{base}} إلى {{quote}} — سعر الصرف ومحوّل عملات',
    descPair:
      '{{base}} و{{quote}}: ما هي كل عملة، ومن يصدرها، وما الذي يحرّك السعر بينهما. أما التحويل نفسه فيجريه {{app}} مجانًا وبلا إنترنت.',
    titleHub: 'تطبيق محوّل العملات — أكثر من 180 عملة بلا إنترنت',
    descHub:
      'حوّل أكثر من 180 عملة عالمية و20 عملة رقمية، متصلًا أو بلا إنترنت، مع مخططات من يوم واحد إلى خمس سنوات. مجاني على أندرويد وiOS، وبلا حساب.',
  },

  pair: {
    h1: 'تحويل {{base}} إلى {{quote}} — {{baseName}} مقابل {{quoteName}}',

    /**
     * بديل يُستعمل حين لا يكون للزوج فقرة ممرّ مكتوبة.
     *
     * الصفحة لا تحسب شيئًا: هي تشرح الزوج وتقدّم التطبيق الذي يحسبه. الجواب
     * أولًا، والجملة الأولى مكتملة المعنى ولا تتجاوز 30 كلمة. أسماء العملات
     * تأتي من CLDR نكرةً («دولار أمريكي»)، فموضعها بين قوسين تعريفًا بالرمز،
     * لا في موضع يطلب تعريفًا أو مطابقة.
     */
    lead:
      'لتحويل {{base}} ({{baseName}}) إلى {{quote}} ({{quoteName}}) استعمل {{app}}: تطبيق مجاني لأندرويد وiOS يواصل الحساب بآخر الأسعار المحفوظة حين تنقطع الشبكة. '
      + 'أما هذه الصفحة فمرجع للزوج نفسه: ما هي كل عملة من العملتين، وأي بنك مركزي يصدرها، وما الذي يحرّك السعر بينهما فعلًا.',

    factsIntro: 'معطيات ثابتة عن طرفَي الزوج — تتبدّل على مدى سنوات، بخلاف السعر الذي يتبدّل خلال اليوم.',

    pegBlock:
      'في هذا الزوج عملة مثبَّتة رسميًا لا تعوم بحرية: {{pegCode}} ({{pegName}})، وتثبيتها قائم منذ عام {{pegSince}}. '
      + 'ولهذا يكاد خط {{base}}/{{quote}} أن يكون مستقيمًا مهما اتّسع المدى الزمني لمخططه في {{app}}. '
      + 'الذي يتبدّل فعلًا هو ما يصل إلى يدك في النهاية: البنوك وشبكات البطاقات ومكاتب الصرافة تضيف هامشها فوق السعر المثبَّت، '
      + 'فتخرج من محلَّين يقول كلاهما إنه يعمل «بالسعر الرسمي» بمبلغين مختلفين. قارن ما تستلمه، لا ما هو معلّق على اللوحة.',

    /**
     * حين تكون إحدى العملتين مثبَّتة أمام عملة ثالثة لا أمام الطرف الآخر.
     * القول إن «العملتين تعومان» في هذه الحالة خطأ صريح.
     */
    anchoredBlock:
      'في هذا الزوج طرف مثبَّت وطرف يتحرك. المثبَّت هو {{pegCode}} ({{pegName}})، ومرساة تثبيته المعلنة: {{pegAnchorName}}. والمتحرك هو {{floatCode}} ({{floatName}}). '
      + 'ولهذا تأتي حركة {{base}}/{{quote}} من جانب {{floatCode}} وحده تقريبًا: حين يتبدّل الزوج، فالذي تبدّل هو {{floatCode}}. '
      + 'ومخطط {{base}}/{{quote}} هو في حقيقته مخطط {{floatCode}} أمام تلك المرساة. '
      + 'وعلى المدى القصير يبقى الهامش الذي يضيفه البنك أو مكتب الصرافة أثقل في كلفتك من فرق السعر نفسه، فالمقارنة المجدية بين مقدّمي الخدمة لا بين أيام الإرسال.',

    floatBlock:
      'العملتان تتحرّكان بحسب العرض والطلب لا بجدول ثابت، فسعر {{base}}/{{quote}} تصنعه السوق وتصنعه قرارات جهتَي الإصدار: {{baseBank}} و{{quoteBank}}. '
      + 'لهذا لا تستطيع أي صفحة أن تطبع رقمًا وتبقى صحيحة بعد ساعة واحدة.',

    howto: [
      'اكتب المبلغ بـ{{base}}.',
      'اختر العملة المطلوبة: {{quote}} ({{quoteName}}) — يمكنك البحث باسم البلد أو باسم العملة أو برمز ISO.',
      'المس الناتج بـ{{quote}} لنسخه أو مشاركته.',
      'ثبّت الزوج {{base}}/{{quote}} في المفضلة ليظهر أمامك بلمسة واحدة.',
    ],

    offline:
      'يحفظ {{app}} آخر أسعار نزّلها على الجهاز نفسه، فيظل تحويل {{base}} إلى {{quote}} شغّالًا في الطائرة، وفي المترو، وفي الخارج مع إغلاق التجوال. والأسعار المحفوظة تحمل تاريخ جلبها، فتعرف دائمًا عمر الرقم الذي بين يديك.',

    /**
     * تظهر في كل صفحة، ونصّها مطابق حرفيًا لما في FAQPage JSON-LD،
     * ولهذا تعيش هنا مرة واحدة فقط.
     */
    faqAlways: [
      {
        q: 'من أين يأتي سعر {{base}}/{{quote}} في {{app}}؟',
        a: 'من مزوّدي بيانات مالية، ويُجدَّد عدة مرات في اليوم كلما توفّر اتصال للجهاز. ويضع {{app}} توقيتًا على كل تحديث، فتعرف دائمًا عمر الرقم الذي بين يديك.',
      },
      {
        q: 'هل يشمل هذا السعر عمولة البنك أو الصرافة؟',
        a: 'لا. يعرض {{app}} سعرًا مرجعيًا بين البنوك. البنوك وشبكات البطاقات ومكاتب الصرافة تضيف هامشها فوقه، فيكون ما تستلمه فعلًا بـ{{quote}} مقابل مبلغك بـ{{base}} أقل منه.',
      },
    ],

    /** يُعرض سؤال واحد منها في كل صفحة، يُختار من الزوج نفسه. */
    faqRotating: [
      {
        q: 'هل يحوّل {{app}} من {{base}} إلى {{quote}} بلا إنترنت؟',
        a: 'نعم. يحتفظ {{app}} على الجهاز بآخر الأسعار التي نزّلها ويواصل التحويل مع انقطاع الاتصال، مُظهرًا تاريخ جلب تلك الأسعار.',
      },
      {
        q: 'كم مرة يجدّد {{app}} سعر {{base}}/{{quote}}؟',
        a: 'عدة مرات في اليوم، من مزوّدي بيانات مالية، في كل مرة يجد فيها الجهاز اتصالًا. ويكتب التطبيق إلى جانب الرقم موعد آخر تجديد له.',
      },
      {
        q: 'هل {{app}} مجاني؟',
        a: 'نعم، تثبيته مجاني على أندرويد وiOS، بلا إنشاء حساب وبلا تسجيل دخول. النسخة المجانية مدعومة بإعلانات، ونسخة Pro تزيلها.',
      },
    ],

    relatedIntro: 'تحويلات أخرى تخص {{base}} و{{quote}} مشروحة على هذا الموقع:',
  },

  hub: {
    h1: 'تطبيق محوّل العملات',
    lead:
      '{{app}} محوّل عملات مجاني لأندرويد وiOS يحسب بين أكثر من 180 عملة عالمية وأكثر من 20 عملة رقمية. '
      + 'يجدّد الأسعار عدة مرات في اليوم، ويرسمها في مخططات من يوم واحد إلى خمس سنوات، ويواصل التحويل بآخر الأسعار المحفوظة حين تنقطع الشبكة. بلا إنشاء حساب وبلا تسجيل دخول.',
    featuresHeading: 'ماذا يفعل {{app}}',
    features: [
      'أكثر من 180 عملة عالمية، يمكن البحث فيها باسم البلد أو باسم العملة أو برمز ISO 4217',
      'أكثر من 20 عملة رقمية، منها بيتكوين (BTC) وإيثيريوم (ETH)',
      'أسعار صرف تُجدَّد عدة مرات يوميًا من مزوّدي بيانات مالية',
      'تحويل كامل بلا اتصال من آخر الأسعار المحفوظة، مع تاريخ جلبها',
      'مخططات تاريخية من يوم واحد إلى خمس سنوات',
      'أداة على الشاشة الرئيسية وقائمة مفضلة تُرتّبها كما تشاء',
      'عدد الخانات العشرية تختاره بنفسك، وأي نتيجة تُنسخ بلمسة واحدة',
      'بلا إنشاء حساب وبلا تسجيل دخول — ثبّت التطبيق وحوّل',
    ],
    pairsHeading: 'أزواج العملات المنشورة بالعربية',
    pairsIntro:
      'كل صفحة أدناه تشرح زوجًا واحدًا وتسرد المعطيات الثابتة عن العملتين.',
    editionsHeading: 'أي نسخة تثبّت',
    editionFree: 'أندرويد — مجاني',
    editionPro: 'أندرويد — النسخة Pro',
    editionIos: 'iOS',
    editionFreeNote: 'كل خصائص التحويل، مدعومة بإعلانات.',
    editionProNote: 'التطبيق نفسه بلا إعلانات.',
    editionIosNote: 'آيفون وآيباد، مع دعم الأداة على الشاشة.',
    supportedHeading: 'كل عملة يدعمها {{app}}',
    supportedIntro:
      'القائمة الكاملة أدناه مقروءة من كتالوج التطبيق نفسه، فهي ما يشحنه التطبيق فعلًا لا رقمًا تسويقيًا مدوّرًا. مرّر المؤشر فوق أي رمز لترى اسم العملة.',
    languagesHeading: 'صفحات الأسعار بلغات أخرى',
  },
},

  vi: {

  /**
   * Official names of the issuing central banks in this language. Only the ones
   * this locale's pairs actually use are listed; anything absent falls back to
   * the English name in tools/lib/currency-facts.mjs, which is correct for
   * institutions whose name is not normally translated.
   */
  banks: {
    USD: "Cục Dự trữ Liên bang Mỹ",
    VND: "Ngân hàng Nhà nước Việt Nam",
    KRW: "Ngân hàng Trung ương Hàn Quốc",
    JPY: "Ngân hàng Trung ương Nhật Bản",
    CNY: "Ngân hàng Nhân dân Trung Quốc",
    TWD: "Ngân hàng Trung ương Đài Loan",
    EUR: "Ngân hàng Trung ương châu Âu",
    THB: "Ngân hàng Trung ương Thái Lan",
    SGD: "Cơ quan Tiền tệ Singapore",
    AUD: "Ngân hàng Dự trữ Úc",
    MYR: "Ngân hàng Trung ương Malaysia",
    CAD: "Ngân hàng Trung ương Canada",
    GBP: "Ngân hàng Trung ương Anh",
  },
  /** Tên ngôn ngữ hiển thị trong bộ chuyển ngôn ngữ của các locale khác. */
  languageName: 'Tiếng Việt',

  ui: {
    home: 'Trang chủ',
    hubBreadcrumb: 'Chuyển đổi tiền tệ',
    convert: 'Quy đổi',
    source: 'Nguồn',
    otherLanguages: 'Trang này bằng ngôn ngữ khác',
    relatedPairs: 'Các cặp tiền liên quan',
    allPairs: 'Tất cả các cặp tiền',
    getTheApp: 'Tải {{app}}',
    playBadge: '{{app}} trên Google Play',
    appleBadge: '{{app}} trên App Store',
    screenshotsAlt: 'Màn hình {{app}}: ',
    screenHome: 'Màn hình chính của bộ quy đổi',
    screenChart: 'Biểu đồ tỷ giá trong quá khứ',
    screenSelect: 'Danh sách tiền tệ có ô tìm kiếm',
    factsHeading: 'Hai đồng tiền đặt cạnh nhau',
    factCode: 'Mã ISO 4217',
    factSymbol: 'Ký hiệu',
    factMinor: 'Số chữ số lẻ (số mũ ISO 4217)',
    factBank: 'Ngân hàng trung ương phát hành',
    factRegion: 'Phát hành cho',
    howToHeading: 'Cách quy đổi {{base}} sang {{quote}} trong {{app}}',
    faqHeading: 'Hỏi đáp về quy đổi {{base}} sang {{quote}}',
    author: 'Đăng bởi Julien Millau, nhà phát triển Android và iOS độc lập.',
    disclaimer:
      'Thông tin trên trang chỉ để tham khảo. Đây không phải lời khuyên tài chính, cũng không phải báo giá có giá trị cho một giao dịch thật.',
    privacy: 'Chính sách quyền riêng tư',
    terms: 'Điều khoản sử dụng',
    contact: 'Liên hệ',
    currencyBasket: 'một rổ tiền tệ',
  },

  /** ≤ 60 đơn vị hiển thị. Phải vừa cả sau khi mã tiền tệ được thay vào. */
  meta: {
    titlePair: 'Quy đổi {{base}} sang {{quote}} – Tỷ giá và bản ngoại tuyến',
    descPair:
      '{{base}} và {{quote}}: mỗi đồng tiền là gì, ai phát hành, cái gì đẩy tỷ giá. Phần quy đổi để {{app}} lo — miễn phí, mất mạng vẫn chạy.',
    titleHub: 'Ứng dụng quy đổi tiền tệ – 180+ đồng tiền, ngoại tuyến',
    descHub:
      'Quy đổi hơn 180 đồng tiền và hơn 20 loại tiền mã hoá, có mạng hay mất mạng đều chạy, kèm biểu đồ từ một ngày tới năm năm. Miễn phí trên Android, iOS.',
  },

  pair: {
    h1: '{{base}} sang {{quote}}: quy đổi {{baseName}} ra {{quoteName}}',

    /**
     * Bản dự phòng khi một cặp chưa có khối corridor riêng.
     *
     * Trang không quy đổi gì cả: nó giải thích cặp tiền rồi chỉ sang ứng dụng
     * làm việc quy đổi. Câu đầu phải tự đứng được khi bị trích ra khỏi ngữ cảnh.
     */
    lead:
      'Muốn quy đổi {{baseName}} ({{base}}) sang {{quoteName}} ({{quote}}), hãy dùng {{app}}: ứng dụng miễn phí cho Android và iOS, mất mạng vẫn quy đổi bằng bộ tỷ giá đã lưu. '
      + 'Còn trang này là chỗ tra chính bản thân cặp tiền: mỗi đồng tiền là gì, ngân hàng trung ương nào phát hành, và cái gì thật sự đẩy tỷ giá giữa hai bên.',

    factsIntro: 'Những thông tin bền của từng đồng tiền — chúng đổi theo đơn vị năm, khác hẳn tỷ giá.',

    pegBlock:
      '{{quoteName}} ({{quote}}) không thả nổi so với {{pegAgainst}}: đồng tiền này được neo cố định từ năm {{pegSince}}. '
      + 'Vì vậy tỷ giá tham chiếu {{base}}/{{quote}} gần như đứng yên, và biểu đồ của nó là một đường gần thẳng. '
      + 'Thứ thật sự thay đổi là số tiền bạn cầm về: ngân hàng, tổ chức thẻ và quầy thu đổi đều cộng thêm phần chênh của họ lên trên mức neo, nên hai nơi cùng nói "theo tỷ giá chính thức" vẫn trả bạn hai con số khác nhau.',

    /**
     * Dùng khi một vế được neo vào một đồng tiền THỨ BA. Viết "cả hai đồng đều
     * thả nổi" ở những trang đó là sai sự thật.
     */
    anchoredBlock:
      '{{pegName}} ({{pegCode}}) được neo vào {{pegAnchorName}}, chứ không neo vào {{floatName}}. '
      + 'Nên tỷ giá {{base}}/{{quote}} gần như chỉ động đậy qua phía {{floatCode}}: cặp này nhích, tức là {{floatName}} vừa nhích. '
      + 'Biểu đồ {{base}}/{{quote}} thực chất là biểu đồ của {{floatCode}} so với {{pegAnchorName}}. Trong vài ngày ngắn, phần chênh mà ngân hàng hay quầy thu đổi cộng vào còn nặng hơn cả bản thân tỷ giá.',

    /**
     * Hai tên tổ chức phải rơi vào vị trí không đòi hỏi gì về ngữ pháp: đặt sau
     * dấu hai chấm, cuối câu. Bản cũ để chúng làm chủ ngữ của "tạo ra lãi suất",
     * và điều đó sai với những nơi không điều hành bằng lãi suất.
     */
    floatBlock:
      'Cặp {{base}}/{{quote}} không có mức neo cố định nào. Tỷ giá hình thành từ cung cầu, từ dòng tiền thương mại giữa hai bên, và từ khoảng cách chính sách tiền tệ giữa hai nơi phát hành: {{baseBank}} và {{quoteBank}}. '
      + 'Ngay cả khi nhà điều hành cố giữ cho biên độ dao động hẹp lại, con số vẫn nhích mỗi ngày — nên không trang tĩnh nào in sẵn một tỷ giá mà đúng được lâu.',

    howto: [
      'Nhập số tiền {{base}}.',
      'Chọn {{quoteName}} ({{quote}}) — gõ mã ISO, tên đồng tiền hay tên quốc gia đều ra.',
      'Chạm vào con số {{quote}} vừa hiện để sao chép hoặc chia sẻ.',
      'Ghim {{base}}/{{quote}} vào mục yêu thích để lần sau mở lên là thấy ngay.',
    ],

    offline:
      '{{app}} giữ lại bộ tỷ giá tải về gần nhất ngay trong máy, nên phép quy đổi {{base}} sang {{quote}} vẫn chạy trên máy bay, dưới hầm gửi xe, hay khi bạn ra nước ngoài và tắt chuyển vùng dữ liệu. Mỗi bộ tỷ giá đều lưu kèm thời điểm lấy về, để bạn luôn biết con số trong tay đã cũ tới mức nào.',

    /**
     * Xuất hiện ở mọi trang: hai câu hỏi ít nơi trả lời thẳng.
     * Câu trả lời phải trùng từng chữ với FAQPage JSON-LD nên chỉ viết một lần.
     */
    faqAlways: [
      {
        q: 'Tỷ giá {{base}}/{{quote}} trong {{app}} lấy từ đâu?',
        a: 'Từ những đơn vị bán dữ liệu thị trường tài chính; hễ máy bắt được mạng là {{app}} kéo về, vài lượt trong ngày. Từng lần cập nhật đều được đóng mốc thời gian, nên bạn luôn thấy con số đang hiện trên màn hình đã cũ tới đâu.',
      },
      {
        q: 'Tỷ giá đó đã gồm phí ngân hàng của tôi chưa?',
        a: 'Chưa. {{app}} đưa ra tỷ giá tham chiếu liên ngân hàng. Ngân hàng, tổ chức thẻ và quầy thu đổi đều cộng phần chênh của họ lên trên, nên số tiền {{quote}} bạn thật sự nhận về cho cùng một khoản {{base}} sẽ ít hơn.',
      },
    ],

    /** Mỗi trang hiện một câu, chọn theo chính cặp tiền đó. */
    faqRotating: [
      {
        q: 'Mất mạng thì {{app}} còn quy đổi {{base}} sang {{quote}} được không?',
        a: 'Được. {{app}} giữ bộ tỷ giá tải về gần nhất ngay trong máy và vẫn quy đổi khi điện thoại không có kết nối, kèm theo ngày giờ đã lấy bộ tỷ giá đó về.',
      },
      {
        q: 'Bao lâu {{app}} làm mới tỷ giá {{base}}/{{quote}} một lần?',
        a: 'Vài lượt trong ngày, lấy từ những đơn vị bán dữ liệu thị trường tài chính, mỗi lần điện thoại bắt được mạng. Ứng dụng ghi luôn thời điểm con số được làm mới lần gần nhất.',
      },
      {
        q: '{{app}} có miễn phí không?',
        a: 'Có, cài miễn phí trên cả Android lẫn iOS, không cần tài khoản, không phải đăng nhập. Bản miễn phí sống bằng quảng cáo; bản Pro thì bỏ quảng cáo đi.',
      },
    ],

    relatedIntro: 'Các cặp khác có {{base}} hoặc {{quote}}, mỗi cặp một trang riêng:',
  },

  hub: {
    h1: 'Ứng dụng quy đổi tiền tệ',
    lead:
      '{{app}} là ứng dụng quy đổi tiền tệ miễn phí cho Android và iOS, xử lý hơn 180 đồng tiền các nước cùng hơn 20 loại tiền mã hoá. '
      + 'Ứng dụng kéo tỷ giá về vài lượt trong ngày, vẽ biểu đồ từ một ngày tới năm năm, và khi mất kết nối thì vẫn quy đổi bằng bộ tỷ giá lưu lần cuối. Không cần tài khoản, không phải đăng nhập.',
    featuresHeading: '{{app}} làm được những gì',
    features: [
      'Hơn 180 đồng tiền các nước, tra bằng mã ISO 4217, tên đồng tiền hoặc tên quốc gia',
      'Hơn 20 loại tiền mã hoá, trong đó có Bitcoin (BTC) và Ethereum (ETH)',
      'Tỷ giá lấy từ nhà cung cấp dữ liệu tài chính, làm mới vài lượt trong ngày',
      'Quy đổi ngoại tuyến trọn vẹn bằng bộ tỷ giá lưu lần cuối, có ghi ngày giờ lấy về',
      'Biểu đồ quá khứ, kéo dài từ một ngày cho tới năm năm',
      'Widget ngoài màn hình chính và danh sách yêu thích tự sắp xếp',
      'Tự đặt số chữ số lẻ; chạm một cái là chép được kết quả',
      'Không cần tài khoản, không phải đăng nhập — cài xong là quy đổi được ngay',
    ],
    pairsHeading: 'Các cặp tiền có trang tiếng Việt',
    pairsIntro:
      'Mỗi trang bên dưới nói về đúng một cặp, kèm những thông tin cố định của cả hai đồng tiền.',
    editionsHeading: 'Nên cài bản nào',
    editionFree: 'Android — bản miễn phí',
    editionPro: 'Android — bản Pro',
    editionIos: 'iOS',
    editionFreeNote: 'Đủ tính năng quy đổi, có quảng cáo.',
    editionProNote: 'Vẫn ứng dụng đó, bỏ quảng cáo.',
    editionIosNote: 'Cho iPhone và iPad, có widget.',
    supportedHeading: 'Toàn bộ đồng tiền {{app}} hỗ trợ',
    supportedIntro:
      'Danh sách dưới đây đọc thẳng từ danh mục bên trong ứng dụng, tức là những gì {{app}} thật sự mang theo chứ không phải một con số làm tròn cho đẹp. Rê chuột lên một mã để xem tên đồng tiền.',
    languagesHeading: 'Trang tỷ giá bằng ngôn ngữ khác',
  },
},

}

// --------------------------------------------------------------------------
// 8. CORRIDORS — the hand-written per-pair prose
// --------------------------------------------------------------------------

/**
 * English corridor blocks — one per pair published in the `en` locale.
 *
 * This is the part of each page that has to be written rather than templated,
 * and it is what makes the page worth publishing: who converts this specific
 * pair, why, and what catches them out. The generator checks that no two pages
 * in a locale share more than 40% of their 3-grams, so filler here fails the
 * build rather than shipping.
 *
 * Shape per pair:
 *   lead   answer-first opening paragraph, ≤ 30-word first sentence, ~55 words
 *   h2     heading for the corridor section
 *   body   2–3 paragraphs, ~200 words total
 *   tips   h3 + 3–5 practical bullets, ~90 words
 *   faq    2 pair-specific questions, on top of the 5 shared ones
 *
 * Only {{app}} may be interpolated. Never state an exchange rate.
 */

const CORRIDORS = {

  en: {
  'usd-eur': {
    lead:
      'One US dollar buys a fraction of a euro, so a USD→EUR conversion always returns a smaller number than you started with. '
      + '{{app}} converts it both ways on your phone, offline included, from the last rates it saved.',
    h2: 'Who converts US dollars to euros',
    body: [
      'USD/EUR is the most heavily traded currency pair in the world, and for most Americans it becomes relevant a few weeks before a trip to Europe. The practical question is rarely "what is the rate" but "how much cash should I change, and where".',
      'The answer that saves the most money is usually: almost none at the airport. Airport bureaux and hotel desks quote well away from the interbank reference, and the gap is proportionally largest on small amounts. Paying by card in euros — and declining the terminal’s offer to bill you in dollars — is normally much closer to the real rate. That offer is dynamic currency conversion, and it exists to earn a margin from you.',
      'The pair also decides what a European online order really costs. Retailers price in euros, and the dollar total your card issuer settles at is fixed on the day the transaction clears, not the day you clicked buy.',
    ],
    tips: {
      h3: 'Practical notes for USD/EUR',
      items: [
        'Both currencies use two decimal places, so nothing is lost in rounding when you convert.',
        'Always choose to be charged in euros on a European card terminal, never in dollars.',
        'The pair reacts sharply to Federal Reserve and European Central Bank meetings, both published on a fixed calendar.',
        'Nineteen-plus countries use the euro, so one rate covers the whole trip if you cross borders.',
      ],
    },
    faq: [
      {
        q: 'Is it better to change dollars before leaving or once in Europe?',
        a: 'Neither, usually. Withdrawing euros from a bank ATM on arrival, or paying by card in euros, is normally closer to the interbank reference than changing cash at an airport bureau on either side.',
      },
      {
        q: 'Why does my card statement show a different USD/EUR rate than this page?',
        a: 'Card networks apply their own rate on the day the transaction settles, plus any foreign-transaction fee your issuer charges. This page shows an interbank reference rate, which is the baseline those figures are built on.',
      },
    ],
  },

  'eur-usd': {
    lead:
      'One euro buys more than one US dollar, so a EUR→USD conversion returns a larger number than you started with. '
      + '{{app}} converts it both ways and keeps working with no connection at all.',
    h2: 'Who converts euros to US dollars',
    body: [
      'Read in this direction, the pair belongs to the European traveller and the freelancer. Someone flying to New York wants to know what their euro budget is worth on the ground; someone invoicing an American client wants to know what a dollar payment will be worth once it lands in a euro account.',
      'Those two needs have different timing. For travel, what matters is the rate on the days you actually spend. For invoicing, it is the rate on the day the payment settles — often weeks after the price was agreed, which quietly turns a fixed-price contract into a currency position nobody intended to take.',
      'It is also the pair most tied to scheduled events. Central bank decisions on both sides are published on a known calendar, and the pair reacts within seconds of each one.',
    ],
    tips: {
      h3: 'Practical notes for EUR/USD',
      items: [
        'US card terminals may offer to bill you in euros; decline, and pay in dollars.',
        'Sales tax is added at the till in most US states, so a shelf price converts to less than you will actually pay.',
        'Invoicing in dollars from the eurozone means carrying the currency risk yourself unless the contract says otherwise.',
        '{{app}} charts the pair from one day to five years, which shows whether the current level is unusual.',
      ],
    },
    faq: [
      {
        q: 'Should I invoice an American client in euros or dollars?',
        a: 'Invoicing in euros moves the currency risk to the client; invoicing in dollars keeps it with you. If you invoice in dollars, the euro amount you receive depends on the rate at settlement, not at signature.',
      },
      {
        q: 'Why is the converted amount different from the price I see advertised in the United States?',
        a: 'US advertised prices usually exclude sales tax, which varies by state and is added at payment. Convert the final total rather than the shelf price.',
      },
    ],
  },

  'usd-mxn': {
    lead:
      'One US dollar buys many Mexican pesos, so a USD→MXN conversion returns a much larger number. '
      + '{{app}} converts it both ways and keeps working offline, which matters where mobile coverage disappears.',
    h2: 'Who converts US dollars to Mexican pesos',
    body: [
      'USD/MXN is a border pair before it is a market pair. It is checked in Tijuana and El Paso as often as on trading desks — by people crossing for work, for dental care, for family — and by the very large number of US residents who send money to Mexico every month.',
      'For those transfers the reference rate is only half the story. What arrives depends on the provider’s margin on top of it plus a fixed fee, and providers advertise whichever half looks better. Knowing the interbank baseline first is the only way to see the real cost of a transfer.',
      'For travel, much of Mexico outside resorts and large cities still runs on cash, and ATM rates vary far more between machines than card rates do between banks.',
    ],
    tips: {
      h3: 'Practical notes for USD/MXN',
      items: [
        'Dollars are accepted in border and resort towns, but almost always at a rate worse than a peso ATM withdrawal.',
        'Compare a transfer provider’s quoted rate against the interbank rate in {{app}} before sending, not just its advertised fee.',
        'Mexican ATMs frequently offer conversion to dollars — decline it and take pesos.',
        'Save the rate in {{app}} before driving out of coverage; it converts from the last stored figure.',
      ],
    },
    faq: [
      {
        q: 'How do I tell whether a money-transfer service is giving me a fair USD/MXN rate?',
        a: 'Compare its quoted rate against an interbank reference rate — the one in {{app}}, for instance. The gap between the two, plus any fixed fee, is the true cost of the transfer; the advertised fee alone rarely is.',
      },
      {
        q: 'Should I pay in dollars or pesos in Mexico?',
        a: 'Pesos. Merchants accepting dollars set their own conversion rate, which is normally well below what the same money would fetch through a card or ATM withdrawal in pesos.',
      },
    ],
  },

  'usd-inr': {
    lead:
      'One US dollar buys many Indian rupees, so a USD→INR conversion returns a much larger number. '
      + '{{app}} converts the pair both ways on your phone, offline included.',
    h2: 'Who converts US dollars to Indian rupees',
    body: [
      'The United States to India corridor is one of the largest remittance flows in the world, and this pair is watched far more closely by families than by traders. The pattern is distinctive: people follow the rate for days, then transfer a large sum when it looks favourable, because a small move applied to a large amount is real money.',
      'That habit only works if you follow the right number. The rate quoted by a transfer service already contains its margin; the interbank reference is the baseline you compare offers against. The distance between the two is the actual price of the transfer, and it is often larger than the advertised fee.',
      'The pair matters in the other direction too, for the growing number of Indian contractors and freelancers billing American clients in dollars.',
    ],
    tips: {
      h3: 'Practical notes for USD/INR',
      items: [
        'Indian amounts are commonly written in lakh (100,000) and crore (10,000,000) rather than millions.',
        'The rupee has an ISO 4217 exponent of 2, but paise are effectively out of circulation in day-to-day use.',
        'Transfer costs usually fall as the amount rises, so one larger transfer often beats several small ones.',
        'Pin the pair as a favourite in {{app}} to see it first every time you open the app.',
      ],
    },
    faq: [
      {
        q: 'What is a lakh and a crore in dollar terms?',
        a: 'A lakh is 100,000 rupees and a crore is 10,000,000 rupees. Convert those rupee figures with the converter above to see the dollar equivalent, since the grouping is a way of writing numbers, not a separate unit.',
      },
      {
        q: 'Do I get a better USD/INR rate by sending a larger amount?',
        a: 'Usually the rate itself is unchanged, but the fixed fee is spread over more money, so the effective cost per dollar falls. Compare the total received, not the headline rate.',
      },
    ],
  },

  'usd-gbp': {
    lead:
      'One US dollar buys less than one pound sterling, so a USD→GBP conversion returns a smaller number. '
      + '{{app}} shows both directions at once, which is the fastest way to avoid reading this pair backwards.',
    h2: 'Who converts US dollars to British pounds',
    body: [
      'This pair comes up for American visitors to the United Kingdom and for US shoppers buying from British sites — a category that grew with independent UK sellers on marketplaces and with brands shipping direct to consumers worldwide.',
      'The trap here is direction. The market quotes sterling the other way round by convention, as GBP/USD, so a headline figure in the news normally tells you what one pound is worth in dollars rather than the reverse. Read it the wrong way and everything looks far cheaper than it is.',
      'For UK purchases there is a second cost that is easy to miss: import duty and handling charges assessed on the American side, applied to the converted value rather than the price you saw.',
    ],
    tips: {
      h3: 'Practical notes for USD/GBP',
      items: [
        'UK shelf prices include VAT; US prices normally exclude sales tax. Compare final totals, not tickets.',
        'Scotland and Northern Ireland issue their own banknotes; they are the same pound and the same rate.',
        'Card terminals in the UK will offer to bill you in dollars — decline and pay in pounds.',
        'Check the converted total before ordering from a UK site so the landed cost holds no surprises.',
      ],
    },
    faq: [
      {
        q: 'Why do news reports quote GBP/USD instead of USD/GBP?',
        a: 'Market convention quotes sterling as the base currency, so the headline number is dollars per pound. This page converts in the direction you asked for and shows the inverse table underneath, so both readings are available.',
      },
      {
        q: 'Are Scottish banknotes worth the same as Bank of England notes?',
        a: 'Yes. They are the same currency at the same rate. Some retailers outside Scotland are unfamiliar with them, but no conversion is involved.',
      },
    ],
  },

  'usd-cad': {
    lead:
      'The US and Canadian dollars are different currencies that share a name and a symbol, so a USD→CAD conversion is never one-for-one. '
      + '{{app}} makes the gap explicit in both directions.',
    h2: 'Who converts US dollars to Canadian dollars',
    body: [
      'Two currencies sharing a name is a genuine source of error, and this is the pair where it shows. Prices on both sides of the border are written with the same dollar sign, so a Canadian price read as an American one looks like a bargain that is not there.',
      'The corridor is dense: cross-border shopping, Canadian snowbirds wintering in Florida and Arizona on Canadian accounts, Canadians employed by American companies, and freight moving constantly in both directions. For all of them this is a daily-life number, not a trading one.',
      'It also moves with oil. The Canadian dollar has a long-standing relationship with crude prices, which is why the pair sometimes shifts on energy news rather than on anything either central bank announced.',
    ],
    tips: {
      h3: 'Practical notes for USD/CAD',
      items: [
        'Canadian prices exclude GST and provincial sales tax, added at the till and varying by province.',
        'Some Canadian retailers accept US dollars at a posted "par" rate that is worse than the market one.',
        'Snowbirds spending several months a year in the US often convert in tranches rather than all at once.',
        '{{app}} charts the pair up to five years back, which puts an unusual week in perspective.',
      ],
    },
    faq: [
      {
        q: 'Why do both currencies use the dollar sign?',
        a: 'Both adopted the dollar independently. When a price could be either, look for the CA$ or US$ prefix, or the ISO codes CAD and USD, and convert the figure rather than assuming parity.',
      },
      {
        q: 'Why does the Canadian dollar move when oil prices change?',
        a: 'Energy is a large share of Canadian exports, so demand for crude tends to move demand for the currency alongside it. The effect is a tendency, not a rule, and it can be overridden by interest-rate decisions.',
      },
    ],
  },

  'usd-jpy': {
    lead:
      'The Japanese yen has an ISO 4217 exponent of zero — there are no yen cents — so a USD→JPY conversion returns a whole number with several digits. '
      + 'That is normal, not an error.',
    h2: 'Who converts US dollars to Japanese yen',
    body: [
      'This pair carries a formatting trap that catches almost every first-time visitor to Japan. A price with five digits is ordinary, and a converted figure that looks alarming usually is not. Reading a yen price as though it had two decimal places makes everything look a hundred times more expensive.',
      'It matters for American travellers, for the import trade, and for the large number of people buying Japanese goods directly — cameras, instruments, hobby items — from sellers who price in yen and ship worldwide.',
      'It is also one of the most volatile major pairs, because Japanese monetary policy has run on a different track from the American one for years. Multi-year swings have been large enough that the same trip can cost noticeably more or less than it would have a year earlier.',
    ],
    tips: {
      h3: 'Practical notes for USD/JPY',
      items: [
        'There is no subdivision of the yen in circulation, so converted amounts are always whole.',
        'Japan remains partly a cash economy; convenience-store ATMs are the most reliable for foreign cards.',
        'Tax-free shopping for visitors is processed in yen at the point of sale, before any conversion.',
        'Offline conversion is genuinely useful underground, where visitor connectivity is unreliable.',
      ],
    },
    faq: [
      {
        q: 'Why does a Japanese price have no decimal places?',
        a: 'The yen has an ISO 4217 minor-unit exponent of zero, so it has no circulating subdivision. A price of several thousand yen is an everyday amount, not a mis-keyed figure.',
      },
      {
        q: 'Is Japan a card country or a cash country?',
        a: 'Both, unevenly. Cards are accepted in cities and chains, while smaller restaurants, shrines and rural businesses are often cash only. Converting before you withdraw helps size the withdrawal correctly.',
      },
    ],
  },

  'usd-php': {
    lead:
      'One US dollar buys tens of Philippine pesos, so a USD→PHP conversion returns a much larger number. '
      + '{{app}} converts it both ways and keeps the last rate available with no connection.',
    h2: 'Who converts US dollars to Philippine pesos',
    body: [
      'The United States is the largest single source of remittances to the Philippines, and this pair is checked by hundreds of thousands of families and overseas workers on a monthly cycle that tracks pay dates rather than market hours.',
      'Timing is most of the game in this corridor. Because transfers are regular and roughly the same size, a household can measurably increase what arrives over a year simply by sending on better days — which requires knowing the reference rate independently of whichever provider is quoting.',
      'The corridor also runs the other way, for American retirees and long-stay visitors living on dollar income in the Philippines, whose local spending power moves with the same number.',
    ],
    tips: {
      h3: 'Practical notes for USD/PHP',
      items: [
        'Remittance providers price differently on weekends, when the interbank market is closed.',
        'Cash-pickup and bank-deposit transfers often carry different rates from the same provider.',
        'Peso amounts are commonly quoted in thousands; check the digits before confirming a transfer.',
        'Provincial connectivity is patchy, so offline conversion is worth having on the ground.',
      ],
    },
    faq: [
      {
        q: 'Does sending money on a weekend change the USD/PHP rate I get?',
        a: 'It can. The interbank market is closed at weekends, so providers quote from a stale reference and often add a wider margin to cover the risk of a Monday move.',
      },
      {
        q: 'Is cash pickup or bank deposit better value?',
        a: 'It depends on the provider — the two channels frequently carry different rates and fees for the same transfer. Compare the amount actually received in pesos rather than the headline rate.',
      },
    ],
  },

  'usd-aud': {
    lead:
      'One US dollar buys more than one Australian dollar, so a USD→AUD conversion returns a slightly larger number. '
      + 'Two currencies, one dollar sign — {{app}} keeps the two apart.',
    h2: 'Who converts US dollars to Australian dollars',
    body: [
      'This is the pair for American travel to Australia, for students on exchange, and for the steady traffic of people buying from Australian sellers — outdoor equipment, surf and skate labels, specialist retailers with no American distribution.',
      'The Australian dollar is a commodity currency: it tends to move with iron ore, coal and broader demand from Asia rather than purely with domestic news. That gives the pair a different rhythm from the European majors, and explains why it can drift quietly for months and then move quickly.',
      'For a long trip the practical consequence is that the rate you budgeted at booking may not be the rate you spend at. Checking periodically rather than once is what avoids the surprise.',
    ],
    tips: {
      h3: 'Practical notes for USD/AUD',
      items: [
        'Australian advertised prices include GST, so the ticket price is what you pay.',
        'The pair is more sensitive to commodity demand than to either country’s domestic data.',
        'Distances in Australia mean long stretches without coverage; offline conversion earns its place.',
        'Tipping is not customary, so a converted restaurant total needs no mental surcharge.',
      ],
    },
    faq: [
      {
        q: 'Do Australian prices include tax?',
        a: 'Yes. Goods and services tax is included in the advertised price, so the converted figure is the amount you will actually be charged — unlike in the United States, where sales tax is added at the till.',
      },
      {
        q: 'Why is the Australian dollar called a commodity currency?',
        a: 'A large share of Australian exports are raw materials, so demand for those exports tends to move demand for the currency. Commodity news can therefore shift the pair more than domestic economic releases do.',
      },
    ],
  },

  'usd-vnd': {
    lead:
      'The Vietnamese dong has an ISO 4217 exponent of zero and trades at tens of thousands to the dollar, so a USD→VND conversion returns a very large whole number. '
      + 'Counting the digits is the whole skill.',
    h2: 'Who converts US dollars to Vietnamese dong',
    body: [
      'This pair produces the largest figures most American travellers will ever read on a price tag. Everyday amounts run into the hundreds of thousands, and dropping or adding a zero is by far the most common mistake visitors make — the banknote denominations do not help, since several look alike.',
      'It is used by travellers, by the growing population of remote workers based in Ho Chi Minh City and Da Nang, and by American importers, for whom Vietnam has become a major manufacturing source.',
      'The dong is closely managed against the dollar by the State Bank of Vietnam, so the pair moves in a narrow, slow range compared with a freely floating currency. That makes the reference rate stable — but it does not make bureau margins stable, and those still vary widely between locations.',
    ],
    tips: {
      h3: 'Practical notes for USD/VND',
      items: [
        'Prices are often written with the đ suffix or abbreviated in thousands ("50k" means 50,000).',
        'The dong has no circulating subdivision, so converted amounts are always whole numbers.',
        'Exchanging currency in Vietnam is legal only through licensed banks and authorised counters; informal dealers are not.',
        'Offline conversion is the practical answer when you are standing in a market with no signal.',
      ],
    },
    faq: [
      {
        q: 'What does a price written as "50k" mean in Vietnam?',
        a: 'It means 50,000 dong. Shortening prices to thousands is standard on menus and market signs, so multiply by a thousand before converting.',
      },
      {
        q: 'Why does the USD/VND rate barely move?',
        a: 'The State Bank of Vietnam manages the dong closely against the dollar rather than letting it float freely, so the pair moves in a narrow band. Bureau and bank margins vary far more than the reference rate does.',
      },
    ],
  },

  'usd-krw': {
    lead:
      'The Korean won has an ISO 4217 exponent of zero, so a USD→KRW conversion returns a whole number in the thousands. '
      + '{{app}} shows both directions and keeps the pair a tap away.',
    h2: 'Who converts US dollars to Korean won',
    body: [
      'This pair is checked by American travellers to Seoul, by the very large audience buying Korean cosmetics, music and fashion directly from Korean sites, and by students and military families based in the country.',
      'Like the yen and the dong, the won has no circulating subdivision, so prices carry more digits than an American shopper expects. A cafe bill in the thousands is unremarkable.',
      'Korean online retail is one of the clearest places where paying in the local currency, rather than accepting a dollar conversion at checkout, makes a visible difference — merchant-side conversion is frequently the worst rate in the whole transaction.',
    ],
    tips: {
      h3: 'Practical notes for USD/KRW',
      items: [
        'Choose to be billed in won on Korean sites; the dollar option is a merchant conversion.',
        'Won has no subdivision, so converted amounts are whole numbers in the thousands.',
        'Transport and convenience purchases run on prepaid cards, topped up in won.',
        'Pin the pair as a favourite in {{app}} if you shop from Korean sites regularly.',
      ],
    },
    faq: [
      {
        q: 'Should I pay a Korean website in dollars or won?',
        a: 'In won. When a site offers to charge you in dollars it is applying its own conversion, which is usually further from the interbank reference than your card issuer’s rate would be.',
      },
      {
        q: 'Why are Korean prices so long?',
        a: 'The won has an ISO 4217 minor-unit exponent of zero and trades in the thousands to the dollar, so ordinary purchases are four- and five-digit figures. No decimal places are involved.',
      },
    ],
  },

  'usd-cny': {
    lead:
      'The Chinese currency is the renminbi and its unit is the yuan, quoted as CNY onshore. '
      + 'A USD→CNY conversion returns single-digit multiples, and {{app}} runs it both ways.',
    h2: 'Who converts US dollars to Chinese yuan',
    body: [
      'This pair sits behind a very large share of world trade, and for individuals it surfaces in sourcing, in cross-border e-commerce and in travel to the mainland.',
      'One detail causes constant confusion: the currency is the renminbi, the unit is the yuan, and there are two exchange rates. CNY is the onshore rate, managed by the People’s Bank of China within a daily band; CNH is the offshore rate that trades freely in Hong Kong. They are normally close but not identical, and a quote may refer to either.',
      'For anyone buying from Chinese suppliers the consequence is practical: a quoted price and a settled price can differ without anyone having made a mistake.',
    ],
    tips: {
      h3: 'Practical notes for USD/CNY',
      items: [
        'Renminbi is the currency, yuan is the unit — both refer to the same money.',
        'CNY is the onshore rate and CNH the offshore one; check which a supplier is quoting.',
        'Mainland payment apps settle in yuan, so a converted figure is what leaves your card.',
        '{{app}} charts the pair over five years, which shows how tightly the onshore rate is steered.',
      ],
    },
    faq: [
      {
        q: 'What is the difference between CNY and CNH?',
        a: 'CNY is the onshore yuan, managed by the People’s Bank of China within a daily trading band. CNH is the offshore yuan traded in Hong Kong, which floats more freely. The two are usually close but rarely identical.',
      },
      {
        q: 'Is it renminbi or yuan?',
        a: 'Renminbi is the name of the currency; the yuan is its unit of account. Saying "100 yuan" is correct in the same way "100 pounds" is, while "renminbi" names the currency itself.',
      },
    ],
  },
},

  fr: {
  'eur-dzd': {
    lead:
      'Convertir des euros (EUR) en dinars algériens (DZD) revient à multiplier le montant en euros par le taux EUR/DZD officiel, celui de la Banque d’Algérie. '
      + 'Ce calcul, {{app}} le fait sur votre téléphone, gratuitement et hors réseau ; cette page explique pourquoi ce taux officiel n’est pas celui qu’on vous annonce depuis Alger.',
    h2: 'Qui convertit des euros en dinars algériens',
    body: [
      'Cette paire est d’abord celle d’une diaspora : l’Insee recense plus de 800 000 personnes nées en Algérie vivant en France, auxquelles s’ajoutent leurs enfants binationaux, et l’été remplit les ferries qui relient Marseille et Alicante à Alger ou à Oran. Le dinar se convertit donc surtout dans un contexte familial : argent envoyé aux parents, budget de vacances, achat de terrain ou frais de santé.',
      'Première particularité : le dinar n’est pas convertible hors d’Algérie. Aucun bureau de change français ne le cote sérieusement, et la sortie de billets du territoire algérien est interdite. Autrement dit, la conversion se fait sur place ou par virement, jamais en achetant des dinars avant le départ.',
      'Deuxième particularité, plus délicate : deux niveaux de prix coexistent. Le taux publié par la Banque d’Algérie sert aux guichets bancaires, à Algérie Poste et aux transferts officiels ; le change de gré à gré, très visible aux abords du square Port-Saïd à Alger, valorise l’euro davantage. C’est le taux officiel que reprend {{app}}, ce qui explique l’écart avec le chiffre que votre famille annonce au téléphone.',
    ],
    tips: {
      h3: 'À savoir avant une conversion EUR/DZD',
      items: [
        'Le dinar n’est ni achetable en France ni exportable d’Algérie : prévoyez des euros en espèces ou un virement, pas des dinars dans la poche.',
        'Les prix se disent couramment en centimes : « trois cents millions » signifie trois millions de dinars. Ramenez le prix en dinars avant de le convertir.',
        'Les pièces en centimes ont disparu de la circulation, les montants du quotidien sont arrondis au dinar.',
        'Les devises importées doivent être déclarées en douane au-delà du seuil en vigueur ; sans déclaration, ressortir des sommes non dépensées devient compliqué.',
        '{{app}} garde le dernier taux en mémoire, pratique quand l’itinérance de données reste coupée pendant tout le séjour.',
      ],
    },
    faq: [
      {
        q: 'Peut-on acheter des dinars algériens en France ?',
        a: 'Pas en pratique. Le dinar est une monnaie non convertible : les bureaux de change français ne le proposent pas, et sortir des billets d’Algérie est interdit. La conversion se fait à l’arrivée, en agence, à la poste ou par virement.',
      },
      {
        q: 'Pourquoi le taux annoncé par ma famille en Algérie diffère-t-il du taux officiel ?',
        a: 'Parce qu’il ne s’agit pas du même marché. Le taux de référence officiel, celui que reprend {{app}}, est celui des guichets et des virements. Le change de gré à gré se négocie à un autre niveau, variable selon la ville, le jour et le montant.',
      },
    ],
  },

  'eur-mad': {
    lead:
      'Convertir des euros (EUR) en dirhams marocains (MAD) donne un montant plus élevé en dirhams, que {{app}} calcule dans les deux sens, gratuitement et sans connexion. '
      + 'Comme le dirham circule très peu hors du Maroc, ce calcul sert surtout à préparer un change sur place ou un virement : c’est précisément ce à quoi sert cette page.',
    h2: 'Qui convertit des euros en dirhams marocains',
    body: [
      'Le Maroc concentre trois usages français différents. Les transferts de la communauté marocaine de France, d’abord, qui pèsent lourd dans les recettes extérieures du royaume et culminent l’été avec l’opération Marhaba et les traversées par Algésiras, Sète ou Tanger Med. Le tourisme ensuite, Marrakech et Agadir figurant parmi les destinations les plus fréquentées au départ de France. Les résidences secondaires enfin, qui imposent une conversion régulière pour des charges libellées en dirhams.',
      'Le dirham n’est pas une monnaie flottante ordinaire : Bank Al-Maghrib le pilote face à un panier où l’euro pèse davantage que le dollar, à l’intérieur d’une bande de fluctuation élargie en mars 2020. Conséquence concrète : le taux EUR/MAD évolue dans un couloir étroit, et guetter le bon jour rapporte beaucoup moins que choisir le bon canal de change.',
      'Le dirham reste par ailleurs partiellement convertible. L’Office des changes plafonne la sortie de billets, et la reconversion des dirhams non dépensés à l’aéroport suppose de présenter les bordereaux d’achat. Le réflexe utile est donc de changer par petites tranches et de garder chaque justificatif jusqu’au retour.',
    ],
    tips: {
      h3: 'Repères pratiques pour la paire EUR/MAD',
      items: [
        'Conservez les bordereaux de change : ils sont exigés pour reconvertir vos dirhams avant l’embarquement.',
        'L’exportation de billets en dirhams est plafonnée à 2 000 MAD par personne ; au-delà, changez avant de partir.',
        'Dans les souks de Marrakech ou de Casablanca, un prix annoncé en rials se divise par vingt pour obtenir des dirhams.',
        'Les grosses sommes, voiture ou terrain, se comptent souvent en centimes : cent centimes font un dirham.',
        'La carte passe dans les grandes villes et les stations, mais les taxis, les médinas et les petits riads restent au liquide.',
      ],
    },
    faq: [
      {
        q: 'Vaut-il mieux changer ses euros en France ou au Maroc ?',
        a: 'Au Maroc dans la très grande majorité des cas. Le dirham n’étant pas librement coté à l’étranger, un guichet français le traite comme une devise exotique, avec un écart large, alors que les bureaux marocains travaillent sur des marges plus serrées.',
      },
      {
        q: 'Que signifie un prix annoncé en rials ?',
        a: 'Le rial est une unité de compte orale héritée de l’ancien système : vingt rials font un dirham. « Deux mille rials » correspond donc à cent dirhams. Ramenez toujours le prix en dirhams avant de le convertir en euros.',
      },
    ],
  },

  'eur-tnd': {
    lead:
      'Le dinar tunisien (TND) se divise en mille millimes : une conversion depuis l’euro (EUR) donne donc un montant à trois décimales, et non deux. '
      + '{{app}} respecte cette précision et laisse régler le nombre de décimales affichées ; cette page rassemble ce qu’il faut savoir avant de changer de l’argent en Tunisie.',
    h2: 'Qui convertit des euros en dinars tunisiens',
    body: [
      'Le dinar tunisien fait partie du très petit groupe de monnaies dont l’exposant ISO 4217 vaut 3, avec les dinars koweïtien, bahreïni, jordanien, libyen et irakien. Sur une étiquette, à la pompe ou sur un ticket de caisse, le prix s’écrit avec trois chiffres après la virgule. Lire ce troisième chiffre comme un centime multiplie mécaniquement l’erreur d’appréciation d’un facteur dix.',
      'La France est de longue date le premier marché touristique européen pour la Tunisie, et la communauté tunisienne installée en France entretient un flux régulier de transferts et de séjours familiaux. Or le dinar est lui aussi non convertible : il ne s’achète pas en France, son importation et son exportation sont prohibées, et le change se fait donc à l’arrivée, en banque, à l’hôtel ou au comptoir de l’aéroport.',
      'Le reçu remis lors du change n’est pas un détail administratif. Il conditionne la reconversion des dinars restants au départ, dans une proportion limitée de ce que vous avez changé. Sans bordereau, les billets qui restent dans le portefeuille ne seront plus échangeables une fois la frontière passée.',
    ],
    tips: {
      h3: 'Millimes et change : les points de vigilance',
      items: [
        'Un dinar vaut mille millimes ; un prix écrit 4,750 se lit quatre dinars et sept cent cinquante millimes.',
        'Réglez la précision d’affichage sur trois décimales dans {{app}} pour retrouver exactement les prix tunisiens.',
        'Ni achat ni sortie de billets : le change se fait sur place, à l’arrivée.',
        'Gardez chaque bordereau de change, la reconversion au départ en dépend et reste plafonnée.',
        'Les hôtels changent à toute heure mais rarement au meilleur écart : gardez-les pour le dépannage.',
      ],
    },
    faq: [
      {
        q: 'Pourquoi les prix tunisiens ont-ils trois chiffres après la virgule ?',
        a: 'Parce que l’exposant ISO 4217 du dinar tunisien vaut 3 : la monnaie se divise en mille millimes et non en cent centimes. Le troisième chiffre fait partie du prix, il ne s’ignore pas.',
      },
      {
        q: 'Peut-on ramener des dinars tunisiens en France ?',
        a: 'Non, leur exportation est interdite et aucun bureau français ne les reprend. Reconvertissez avant l’enregistrement, bordereaux en main ; passé le contrôle, les billets ne sont plus échangeables.',
      },
    ],
  },

  'eur-chf': {
    lead:
      'Convertir des euros (EUR) en francs suisses (CHF) applique au montant le taux EUR/CHF du moment, une opération que {{app}} garde disponible hors ligne, sans compte. '
      + 'C’est l’opération que refont chaque mois les travailleurs frontaliers payés en francs — ils sont plus de 200 000 à faire le trajet depuis la France — et dont cette page détaille le coût réel.',
    h2: 'Qui convertit des euros en francs suisses',
    body: [
      'Le travail frontalier domine cette paire. Le Grand Genève, l’agglomération bâloise, l’Arc jurassien et le canton de Vaud emploient une population française qui touche un salaire en francs, rembourse un crédit en euros et fait ses courses des deux côtés de la frontière. Pour elle, la vraie question n’est pas le niveau du taux mais le coût de la conversion mensuelle : commission de change, forfait de virement transfrontalier, marge appliquée par la banque. Cumulés sur douze mois, ces frais pèsent souvent plus que la variation du taux lui-même.',
      'La paire a aussi une histoire utile à connaître. De septembre 2011 au 15 janvier 2015, la Banque nationale suisse a défendu un cours plancher face à l’euro, puis l’a abandonné du jour au lendemain ; la paire s’est déplacée en une matinée comme elle ne l’avait pas fait en trois ans. Une monnaie réputée calme n’est pas une monnaie fixe.',
      'Côté commerces, les enseignes proches de la frontière acceptent l’euro, mais à un cours maison affiché en caisse et rendent la monnaie en francs. C’est une conversion faite par le marchand, rarement à votre avantage.',
    ],
    tips: {
      h3: 'Frontaliers et courses en Suisse',
      items: [
        'Payez en francs dans les commerces suisses : régler en euros fait appliquer le cours de l’enseigne, et la monnaie revient en francs.',
        'Pour un salaire frontalier, comparez les banques sur le total prélevé chaque mois, pas sur le taux annoncé.',
        'Au retour par la route, la franchise douanière française est de 300 € de marchandises par adulte ; au-delà, la TVA est due.',
        'Les prix suisses sont affichés toutes taxes comprises : le montant converti est celui que vous paierez.',
        'Le franc reste une valeur refuge : les épisodes de tension sur les marchés le font monter, indépendamment de la conjoncture suisse.',
      ],
    },
    faq: [
      {
        q: 'Faut-il payer en euros ou en francs dans un commerce suisse ?',
        a: 'En francs. Les enseignes frontalières acceptent l’euro à un cours qu’elles fixent elles-mêmes, généralement moins favorable que celui appliqué par votre carte, et elles rendent la monnaie en francs suisses.',
      },
      {
        q: 'Comment un frontalier réduit-il le coût de conversion de son salaire ?',
        a: 'En additionnant tout ce que sa banque prélève : commission de change en pourcentage, frais fixes de virement transfrontalier, éventuels frais de tenue de compte en devise. À salaire égal, l’écart entre deux établissements peut se chiffrer en centaines d’euros par an.',
      },
    ],
  },

  'eur-usd': {
    lead:
      'Convertir des euros (EUR) en dollars des États-Unis (USD) revient à multiplier le montant par le taux EUR/USD, la paire la plus traitée au monde. '
      + '{{app}} l’applique dans les deux sens, y compris en avion ; cette page explique pourquoi le montant converti reste toujours en dessous de ce que vous paierez sur place.',
    h2: 'Qui convertit des euros en dollars américains',
    body: [
      'Pour un public français, cette paire surgit dans trois situations : un voyage aux États-Unis, une commande sur un site américain, et la lecture d’un prix affiché en dollars sur une place de marché en ligne. Les trois réservent la même déconvenue, née d’une habitude française : ici, le prix affiché est celui que l’on paie ; là-bas, non.',
      'Aux États-Unis, l’étiquette est hors taxe. La sales tax s’ajoute au passage en caisse, son taux varie selon l’État et parfois selon la ville, et au restaurant un pourboire de 18 à 20 % vient encore s’ajouter. Un menu converti à l’euro près peut donc annoncer un quart de moins que l’addition finale.',
      'Pour une commande, l’écart vient de la douane. Depuis le 1er juillet 2021, tout colis importé dans l’Union européenne supporte la TVA dès le premier euro, les droits de douane s’ajoutent au-delà de 150 € de valeur, et le transporteur facture des frais de dossier. Le prix converti est un plancher, pas le coût final. Quant au niveau du taux, il réagit au calendrier connu des réunions de la Réserve fédérale et de la Banque centrale européenne.',
    ],
    tips: {
      h3: 'Voyage et achats aux États-Unis',
      items: [
        'Les prix américains sont affichés hors taxe : la sales tax tombe en caisse et dépend de l’État.',
        'Comptez 18 à 20 % de pourboire au restaurant, calculés sur le montant avant taxes.',
        'Refusez la conversion en euros proposée par un terminal américain et réglez en dollars.',
        'Sur un achat en ligne, ajoutez la TVA française et, au-delà de 150 €, les droits de douane et les frais du transporteur.',
        '{{app}} trace la paire de la journée écoulée aux cinq dernières années, de quoi situer le niveau du moment.',
      ],
    },
    faq: [
      {
        q: 'Pourquoi le total payé aux États-Unis dépasse-t-il le prix converti ?',
        a: 'Parce que l’affichage américain est hors taxe. La taxe de vente s’ajoute à l’encaissement et le pourboire au restaurant vient par-dessus. Convertissez le montant final estimé, pas l’étiquette.',
      },
      {
        q: 'Comment lire la cotation EUR/USD publiée dans la presse ?',
        a: 'Le chiffre indique combien de dollars vaut un euro : l’euro est la devise de base, le dollar la devise de cotation. Pour lire la cotation dans l’autre sens, il suffit d’intervertir les deux devises dans {{app}}.',
      },
    ],
  },

  'eur-gbp': {
    lead:
      'La livre sterling (GBP) vaut davantage que l’euro (EUR), donc une conversion EUR vers GBP renvoie un montant plus petit que le montant de départ. '
      + '{{app}} s’en charge sur téléphone, réseau ou pas ; cette page traite de tout ce qui vient s’ajouter au prix converti depuis le Brexit.',
    h2: 'Qui convertit des euros en livres sterling',
    body: [
      'Depuis le 1er janvier 2021, commander sur un site britannique est devenu une importation. La TVA française s’applique dès le premier euro, les droits de douane à partir de 150 € de valeur pour les marchandises qui ne sont pas d’origine britannique, et le transporteur ajoute des frais de dédouanement. Symétriquement, un vendeur britannique doit retirer sa TVA de 20 % pour une livraison dans l’Union : si le prix affiché la contient encore, vous la payez deux fois.',
      'Côté voyage, Londres se règle presque intégralement par carte sans contact. Les bus de la capitale n’acceptent plus les espèces depuis 2014, et les prix britanniques sont affichés taxe comprise, ce qui rapproche l’étiquette convertie de la dépense réelle.',
      'Reste le piège des billets. L’Écosse et l’Irlande du Nord émettent leurs propres coupures en livres sterling, parfaitement valables. Jersey, Guernesey, l’île de Man et Gibraltar émettent en revanche des livres locales, à parité avec le sterling mais sans cours légal en Grande-Bretagne : beaucoup de commerçants londoniens les refusent, et aucun bureau de change français ne les reprend.',
    ],
    tips: {
      h3: 'Achats britanniques et espèces au Royaume-Uni',
      items: [
        'Vérifiez que le vendeur britannique a bien déduit sa TVA de 20 % pour une livraison dans l’Union européenne.',
        'Prévoyez la TVA française dès le premier euro et les droits de douane au-delà de 150 € de valeur déclarée.',
        'Sur un terminal britannique, choisissez le paiement en livres plutôt que l’option en euros.',
        'Les bus londoniens ne prennent plus d’espèces depuis 2014 : une carte sans contact suffit.',
        'Ne rapportez pas de livres de Jersey, de Guernesey ou de Gibraltar : elles ne sont pas reprises en France.',
      ],
    },
    faq: [
      {
        q: 'Pourquoi une commande sur un site britannique coûte-t-elle plus cher que le prix converti ?',
        a: 'Parce qu’un colis venu du Royaume-Uni est une importation depuis le 1er janvier 2021 : TVA française dès le premier euro, droits de douane au-delà de 150 € pour les biens non originaires du Royaume-Uni, et frais de dédouanement du transporteur s’ajoutent au montant converti.',
      },
      {
        q: 'Les billets écossais ou de Jersey ont-ils la même valeur ?',
        a: 'Les coupures écossaises et nord-irlandaises sont des livres sterling, de même valeur nominale. Jersey, Guernesey et Gibraltar émettent leurs propres livres, à parité mais sans cours légal en Grande-Bretagne, et les bureaux français ne les échangent pas.',
      },
    ],
  },

  'eur-xof': {
    lead:
      'Le franc CFA d’Afrique de l’Ouest (XOF) est fixé à l’euro (EUR) par une parité qui ne bouge pas : la conversion est une multiplication par une constante, pas un pari de marché. '
      + 'Ce qui change d’un prestataire à l’autre, c’est la marge posée par-dessus, et {{app}} affiche la référence pour la mesurer.',
    h2: 'Qui convertit des euros en francs CFA ouest-africains',
    body: [
      'Huit pays partagent cette monnaie émise par la BCEAO : Bénin, Burkina Faso, Côte d’Ivoire, Guinée-Bissau, Mali, Niger, Sénégal et Togo. La parité n’a pas bougé depuis que l’euro a remplacé le franc français, et avant cela le rapport avec le franc était figé depuis la dévaluation de janvier 1994. Une conversion vers Dakar ou Abidjan est donc arithmétiquement prévisible : le seul inconnu est le coût du transfert.',
      'Or ce coût reste élevé. L’Afrique subsaharienne est de longue date la destination la plus chère au monde pour envoyer de l’argent, et les corridors depuis la France en font partie. Comparer les opérateurs sur leur « taux du jour » n’a aucun sens ici, puisque la parité est identique pour tous ; ce qui se compare, c’est la somme finalement remise en francs CFA, frais et marge déduits.',
      'La dernière étape a beaucoup changé depuis quelques années. Les portefeuilles mobiles, Wave et Orange Money en tête, ont fait chuter le coût du transfert domestique au Sénégal et en Côte d’Ivoire, au point que le choix du canal de réception pèse aujourd’hui autant que celui de l’opérateur international.',
    ],
    tips: {
      h3: 'Envoyer de l’euro vers la zone UEMOA',
      items: [
        'La parité est figée : attendre un meilleur taux n’a pas de sens, seule la marge du prestataire se négocie.',
        'Le franc CFA n’a pas de sous-unité, les montants convertis sont toujours des entiers.',
        'Les billets BCEAO ne circulent pas en Afrique centrale, malgré un nom et une parité identiques.',
        'Comparez les offres sur le montant reçu à l’arrivée, jamais sur la commission annoncée.',
        'Le canal de retrait, espèces en agence ou portefeuille mobile, modifie le coût total autant que l’envoi lui-même.',
      ],
    },
    faq: [
      {
        q: 'Le taux EUR/XOF peut-il changer ?',
        a: 'Seulement par une décision politique. La parité avec l’euro est fixée depuis 1999 et n’a pas varié. La modifier supposerait une dévaluation décidée par les États membres, pas un mouvement de marché.',
      },
      {
        q: 'Pourquoi deux opérateurs ne versent-ils pas la même somme à Dakar ?',
        a: 'Parce qu’ils ajoutent leur propre marge au-dessus de la parité et facturent des frais différents selon le mode de réception : espèces au guichet, compte bancaire ou portefeuille mobile. Le seul chiffre comparable est la somme effectivement remise au bénéficiaire.',
      },
    ],
  },

  'eur-xaf': {
    lead:
      'Le franc CFA d’Afrique centrale (XAF) est arrimé à l’euro (EUR), exactement comme son homologue ouest-africain, mais il s’agit de deux monnaies distinctes. '
      + 'La conversion étant fixe, {{app}} sert surtout à mesurer l’écart entre cette référence et ce qu’un prestataire propose.',
    h2: 'Qui convertit des euros en francs CFA d’Afrique centrale',
    body: [
      'Six pays utilisent le XAF, émis par la BEAC : Cameroun, Congo, Gabon, Guinée équatoriale, République centrafricaine et Tchad. Les communautés camerounaise, gabonaise et congolaise de France alimentent un flux continu de virements familiaux, souvent liés à des échéances précises — frais de scolarité, hospitalisation, construction, cotisations pour des obsèques. Le montant à envoyer se calcule en francs CFA d’abord, en euros ensuite, ce que {{app}} fait dans les deux sens.',
      'Zone pétrolière et forestière, la CEMAC voit ses réserves de change bouger avec le cours du brut, sans que la parité ne s’en trouve affectée : c’est précisément le principe d’un ancrage fixe. En revanche, la réglementation des changes applicable depuis mars 2019 encadre plus strictement les sorties de devises de la zone que les entrées, ce qui rend un envoi depuis la France plus simple qu’un rapatriement en sens inverse.',
      'Sur place, le liquide domine encore largement, et le dernier kilomètre passe fréquemment par un portefeuille mobile de type MTN Mobile Money ou Orange Money. Le retrait en espèces depuis ce portefeuille a son propre barème, à ajouter au coût du virement international.',
    ],
    tips: {
      h3: 'Transferts vers la zone CEMAC',
      items: [
        'Même parité que le franc CFA ouest-africain, mais deux monnaies séparées : une coupure de Douala ne s’utilise pas à Abidjan.',
        'Aucune décimale : les prix courants s’écrivent en milliers de francs, sans centimes.',
        'Depuis mars 2019, la réglementation des changes CEMAC surveille davantage les sorties de devises que les entrées.',
        'Ajoutez le barème de retrait du portefeuille mobile au coût de l’envoi : c’est souvent la part oubliée.',
        'Puisque la parité ne bouge pas, comparez les prestataires sur le total prélevé, jamais sur le taux affiché.',
      ],
    },
    faq: [
      {
        q: 'Quelle différence entre le XAF et le XOF ?',
        a: 'Deux monnaies différentes de même parité avec l’euro. Le XAF est émis par la BEAC pour six pays d’Afrique centrale, le XOF par la BCEAO pour huit pays d’Afrique de l’Ouest. Les billets ne sont pas interchangeables d’une zone à l’autre.',
      },
      {
        q: 'Vaut-il mieux emporter des euros en espèces ou retirer sur place ?',
        a: 'Les deux se pratiquent. Le change d’euros en agence donne un résultat très prévisible puisque la parité est figée, tandis qu’un retrait au distributeur cumule les frais de votre banque et ceux de la banque locale. Comparez ces frais, pas le taux.',
      },
    ],
  },

  'eur-cad': {
    lead:
      'Convertir des euros (EUR) en dollars canadiens (CAD) donne un montant plus grand, et le signe $ partagé avec le dollar américain rend la lecture d’un prix trompeuse. '
      + '{{app}} nomme chaque devise sans ambiguïté et convertit dans les deux sens ; cette page réunit ce qui fausse un budget québécois.',
    h2: 'Qui convertit des euros en dollars canadiens',
    body: [
      'Le Québec porte l’essentiel de cette paire côté français : séjours touristiques, études à Montréal ou à Québec, et surtout permis vacances-travail, dont la France dispose d’un des contingents les plus importants. S’y ajoutent les expatriés payés en dollars canadiens qui suivent la paire comme un chiffre mensuel, pour un loyer ou un remboursement resté en euros.',
      'Le piège local est identique à celui des États-Unis, avec d’autres taux : les prix canadiens sont affichés hors taxes. Au Québec, la TPS fédérale et la TVQ provinciale ajoutent ensemble près de 15 % au passage en caisse, et le pourboire au restaurant se situe entre 15 et 20 %. Une carte de restaurant convertie telle quelle sous-estime donc franchement l’addition.',
      'Deux détails matériels finissent le tableau. La pièce de un cent n’est plus frappée depuis 2012 et la Monnaie royale canadienne a cessé de la distribuer en février 2013 : un règlement en espèces est arrondi au multiple de cinq cents, alors qu’un paiement par carte reste au cent près. Et le dollar canadien est une monnaie de matières premières, corrélée au pétrole, ce qui explique qu’EUR/CAD bouge parfois sur une actualité énergétique plutôt que sur une décision de banque centrale.',
    ],
    tips: {
      h3: 'Budget au Québec et lecture des prix',
      items: [
        'Les prix canadiens s’affichent hors taxes : au Québec, TPS et TVQ ajoutent près de 15 % en caisse.',
        'Pourboire attendu de 15 à 20 % au restaurant, calculé sur le montant avant taxes.',
        'Plus de pièce de un cent distribuée depuis 2013 : les paiements en espèces sont arrondis au multiple de cinq cents.',
        'Un prix précédé d’un simple $ sur un site canadien est en dollars canadiens ; cherchez CA$ ou US$ en cas de doute.',
        'Le huard suit le cours du brut, la paire peut donc réagir à une nouvelle pétrolière.',
      ],
    },
    faq: [
      {
        q: 'Pourquoi l’addition dépasse-t-elle le prix affiché au Canada ?',
        a: 'Parce que les taxes de vente ne sont pas incluses dans l’étiquette mais ajoutées à l’encaissement. Au Québec s’appliquent la taxe fédérale et la taxe provinciale, auxquelles s’ajoute le pourboire au restaurant.',
      },
      {
        q: 'Comment distinguer un prix en dollars canadiens d’un prix en dollars américains ?',
        a: 'Cherchez le préfixe CA$ ou US$, ou le code ISO CAD et USD à côté du montant. Sur un site canadien, un simple $ désigne le dollar canadien. Dans le doute, convertissez plutôt que de supposer une équivalence.',
      },
    ],
  },

  'eur-jpy': {
    lead:
      'Le yen japonais (JPY) n’a pas de sous-unité en circulation : une conversion depuis l’euro (EUR) renvoie donc toujours un nombre entier, sans virgule. '
      + 'Un prix japonais à quatre ou cinq chiffres est ordinaire, et {{app}} affiche le résultat de la même façon hors connexion.',
    h2: 'Qui convertit des euros en yens japonais',
    body: [
      'Le Japon est devenu une destination majeure pour les voyageurs français, et le premier réflexe à acquérir est typographique. Le yen a un exposant ISO 4217 nul : pas de centimes, pas de virgule décimale. Lire un prix japonais comme s’il comportait deux décimales fait paraître le pays cent fois plus cher qu’il ne l’est, ce qui reste l’erreur la plus fréquente à l’arrivée.',
      'Deuxième réflexe : l’argent liquide. Malgré les paiements sans contact, le Japon fait encore une large place aux espèces, et toutes les machines n’acceptent pas les cartes étrangères. Celles des supérettes et de la Japan Post sont les plus fiables. Les cartes de transport Suica ou Pasmo se rechargent en yens, et depuis avril 2021 les prix doivent être affichés toutes taxes comprises : l’étiquette est bien le prix payé, à l’inverse des États-Unis.',
      'Sur les marchés, EUR/JPY est un taux croisé : les banques le reconstituent à partir d’EUR/USD et d’USD/JPY. La paire peut donc bouger à cause d’une statistique américaine, sans qu’aucune nouvelle européenne ou japonaise ne soit tombée.',
    ],
    tips: {
      h3: 'Yens, espèces et détaxe',
      items: [
        'Aucune décimale : le yen ne se divise pas, les montants convertis sont entiers.',
        'Prix affichés toutes taxes comprises depuis avril 2021, l’étiquette correspond au montant payé.',
        'Détaxe pour les visiteurs à partir de 5 000 yens d’achat en boutique agréée, passeport à présenter.',
        'Les distributeurs des supérettes et de la Japan Post acceptent les cartes étrangères plus sûrement que ceux des banques.',
        'Le pourboire ne se pratique pas : le total converti est le total à régler.',
      ],
    },
    faq: [
      {
        q: 'Pourquoi un prix japonais ne comporte-t-il pas de virgule ?',
        a: 'L’exposant ISO 4217 du yen vaut zéro : la monnaie n’a pas de sous-division en circulation. Un plat à quelques milliers de yens est un prix banal, pas une erreur de saisie.',
      },
      {
        q: 'Comment fonctionne la détaxe au Japon ?',
        a: 'Les boutiques agréées déduisent la taxe à la consommation directement en caisse à partir de 5 000 yens d’achat, sur présentation du passeport. L’opération se fait en yens, avant toute conversion vers l’euro.',
      },
    ],
  },

  'eur-thb': {
    lead:
      'Convertir des euros (EUR) en bahts thaïlandais (THB) renvoie un montant nettement plus grand, que {{app}} tient à jour même sans réseau sur les îles. '
      + 'Sur place, le coût réel tient pourtant moins au taux qu’aux frais de retrait, et c’est cette facture-là que détaille cette page.',
    h2: 'Qui convertit des euros en bahts thaïlandais',
    body: [
      'La Thaïlande figure parmi les destinations long-courriers les plus fréquentées au départ de France, et elle abrite une population de retraités et de longs séjours qui vivent d’un revenu en euros. Les deux profils butent sur la même mécanique : le baht se change beaucoup mieux à Bangkok qu’à Paris. Les bureaux indépendants installés près des stations de métro aérien travaillent sur des écarts très serrés, quand un guichet français traite le baht comme une devise secondaire.',
      'Le vrai coût, lui, se cache dans le distributeur. Les banques thaïlandaises prélèvent des frais fixes de l’ordre de 220 bahts par retrait effectué avec une carte étrangère, indépendamment du montant et en plus de ce que facture votre propre banque. Retirer souvent de petites sommes revient donc bien plus cher que retirer rarement de grosses sommes, ou que changer des espèces.',
      'Reste la conversion dynamique, particulièrement insistante en Thaïlande : distributeurs et terminaux proposent presque systématiquement de débiter en euros. Accepter revient à laisser la machine fixer son propre taux, ce qui s’ajoute au reste. Le baht flotte par ailleurs sous la surveillance de la Banque de Thaïlande, qui intervient sur le marché pour lisser les mouvements trop brusques.',
    ],
    tips: {
      h3: 'Change et retraits en Thaïlande',
      items: [
        'Chaque retrait au distributeur thaïlandais coûte environ 220 bahts de frais fixes, en plus de ceux de votre banque : retirez rarement et gros.',
        'Écartez l’option « débit en euros » proposée à l’écran, c’est là que la marge est la plus large.',
        'Les bureaux de change indépendants de Bangkok affichent des écarts plus serrés que l’aéroport ou l’hôtel.',
        'Le satang, centième de baht, ne sert guère qu’en supérette ; ailleurs les prix sont ronds.',
        'Certains sites touristiques pratiquent un tarif distinct pour les visiteurs étrangers, parfois écrit en chiffres thaïs.',
      ],
    },
    faq: [
      {
        q: 'Faut-il acheter ses bahts en France ou en Thaïlande ?',
        a: 'En Thaïlande dans la plupart des cas. Les bureaux de change de Bangkok travaillent sur des écarts étroits, alors qu’un guichet français cote le baht comme une devise peu demandée, donc avec une marge plus large.',
      },
      {
        q: 'Pourquoi mon retrait sur place a-t-il coûté plus cher que prévu ?',
        a: 'Trois coûts se cumulent : les quelque 220 bahts prélevés par la banque thaïlandaise, les frais de retrait à l’étranger de votre propre banque, et, si vous avez accepté le débit en euros à l’écran, la marge de conversion du distributeur.',
      },
    ],
  },

  'usd-eur': {
    lead:
      'Un dollar des États-Unis (USD) vaut moins qu’un euro (EUR), donc une conversion USD vers EUR rend un nombre plus petit que le montant de départ. '
      + '{{app}} garde la paire accessible même sans connexion ; cette page s’adresse à ceux qui encaissent des dollars depuis la France plutôt qu’à ceux qui partent en voyage.',
    h2: 'Qui convertit des dollars américains en euros',
    body: [
      'Lue dans ce sens, la paire appartient à ceux qui reçoivent des dollars sans les avoir demandés. Indépendants et studios facturant un client américain, développeurs et créateurs payés par l’App Store, Google, YouTube ou une place de marché, détenteurs d’actions américaines encaissant un dividende : tous convertissent un revenu, pas un budget de vacances. Le taux qui compte pour eux n’est pas celui du jour de la facture mais celui du jour du règlement, parfois plusieurs semaines plus tard.',
      'Le coût réel se loge dans la ligne « commission de change ». Sur un virement entrant en dollars, une banque française applique une marge sur le taux, puis un forfait de réception, parfois complété par des frais de banque correspondante ; ces montants figurent rarement au même endroit du relevé. Rapprocher l’euro effectivement crédité du taux de référence affiché dans {{app}} est le moyen le plus simple de voir le total réellement payé.',
      'Même logique lorsqu’une plateforme américaine propose de vous régler directement en euros : elle applique alors sa propre conversion, qu’il faut comparer à celle de votre banque plutôt que d’accepter par défaut.',
    ],
    tips: {
      h3: 'Encaisser des dollars depuis la France',
      items: [
        'Une facture libellée en dollars vous laisse porter le risque de change jusqu’au jour du règlement.',
        'Sur un virement entrant, additionnez la commission de change et le forfait de réception avant de comparer deux banques.',
        'Quand une plateforme propose de payer en euros, elle applique sa propre conversion : vérifiez-la.',
        'Les bureaux de change ne reprennent jamais les pièces étrangères, seulement les billets.',
        'Épinglez USD/EUR dans {{app}} pour suivre le niveau entre deux règlements.',
      ],
    },
    faq: [
      {
        q: 'Faut-il facturer un client américain en euros ou en dollars ?',
        a: 'En euros, le risque de change passe au client ; en dollars, il reste chez vous. Dans ce second cas, la somme finalement créditée dépend du taux du jour de règlement et non de celui du jour de la signature.',
      },
      {
        q: 'Pourquoi ma banque ne me crédite-t-elle pas le montant obtenu au taux de référence ?',
        a: 'Parce qu’un taux de référence interbancaire n’est pas un taux client. S’y ajoutent une marge de change exprimée en pourcentage, un forfait de réception de virement international et, selon le circuit emprunté, des frais retenus par une banque intermédiaire.',
      },
    ],
  },
},

  es: {
  'eur-usd': {
    lead:
      'El euro y el dólar estadounidense se mueven cerca de la paridad, así que convertir EUR a USD devuelve una cifra del mismo orden, no un múltiplo. '
      + 'La cuenta la hace {{app}} en el móvil, gratis y también con los datos apagados, a partir de las últimas tasas que descargó.',
    h2: 'Quién convierte euros a dólares estadounidenses',
    body: [
      'EUR/USD es el par más negociado del planeta, pero en España aparece sobre todo en tres situaciones muy concretas: la compra en una tienda online de Estados Unidos, la suscripción a un servicio facturado en dólares y la factura de un autónomo a un cliente estadounidense.',
      'En las tiendas norteamericanas el precio anunciado no lleva incluido el impuesto sobre ventas, que se añade al pagar y varía según el estado e incluso según la ciudad. Lo que hay que pasar a euros es el total final, no el de la etiqueta. Con las suscripciones ocurre lo contrario: el importe en dólares es siempre idéntico, pero el cargo en euros baila cada mes según el día en que pasa el recibo, y esa oscilación no es un error de facturación.',
      'Para quien emite facturas en dólares, lo que cuenta no es el tipo del día en que se cerró el presupuesto, sino el del día en que el banco abona la transferencia. Entre una fecha y otra pueden pasar semanas, y ahí es donde un precio cerrado se convierte en una posición de divisa que nadie quiso abrir.',
    ],
    tips: {
      h3: 'Notas prácticas para EUR/USD',
      items: [
        'Las dos monedas tienen dos decimales, de modo que la conversión no pierde nada por redondeo.',
        'Si un datáfono o una web estadounidense te ofrece cobrarte en euros, rechaza: esa conversión la fija el comercio.',
        'Convierte el total con impuestos incluidos, nunca el precio que aparece en la estantería o en la ficha del producto.',
        'El par reacciona a las reuniones de la Reserva Federal y del Banco Central Europeo, que se anuncian con calendario fijo.',
        '{{app}} dibuja el par de un día a cinco años, útil para ver si el nivel de hoy es raro o de lo más normal.',
      ],
    },
    faq: [
      {
        q: '¿Pago en dólares o en euros al comprar en una web de Estados Unidos?',
        a: 'En dólares. Cuando la tienda ofrece cobrarte en euros está aplicando su propia conversión, casi siempre más alejada de la referencia interbancaria que la que aplicaría el banco emisor de tu tarjeta.',
      },
      {
        q: '¿Facturo a un cliente estadounidense en euros o en dólares?',
        a: 'Facturar en euros traslada el riesgo de cambio al cliente; facturar en dólares te lo quedas tú. Si emites en dólares, los euros que acabarás ingresando dependen del día del cobro, no del día en que firmasteis el precio.',
      },
    ],
  },

  'usd-eur': {
    lead:
      'Convertir USD a EUR responde a la pregunta contraria: cuánto vale en euros un importe que ya tienes en dólares. '
      + 'Esa cifra la da {{app}}, que conserva la última tasa descargada y responde igual dentro de un avión que en casa.',
    h2: 'Quién convierte dólares estadounidenses a euros',
    body: [
      'Leído en este sentido, el par pertenece a quien cobra en dólares y vive en euros: programadores y diseñadores que facturan por plataformas internacionales, tripulaciones y personal de crucero, y latinoamericanos que llegan a España con sus ahorros en dólares porque en su país el dólar es la unidad de cuenta mental para pisos, coches y alquileres.',
      'Para todos ellos la cifra relevante no es la del día en que se acordó el precio, sino la del día en que el dinero aterriza en la cuenta en euros. Las pasarelas de pago aplican su propio margen de conversión, y ese margen solo se ve si comparas el importe abonado con la referencia de esa misma jornada.',
      'Si el dinero viaja en efectivo hay una norma europea que conviene conocer: al entrar o salir de la Unión Europea con 10.000 euros o más, o su equivalente en dólares o en cualquier otra divisa, hay obligación de declararlo en la aduana. No es un impuesto, es una declaración, pero no presentarla puede terminar con el dinero inmovilizado.',
    ],
    tips: {
      h3: 'Notas prácticas para USD/EUR',
      items: [
        'Compara siempre lo realmente abonado en euros con la referencia de ese día: la diferencia es lo que te ha cobrado la plataforma.',
        'Cambiar billetes en las casetas de cambio del centro de las ciudades turísticas suele salir peor que sacar euros de un cajero bancario.',
        'El euro sirve en la mayor parte de la Unión Europea, así que una sola conversión te vale para un viaje que cruce varias fronteras.',
        'El billete de 500 euros dejó de emitirse en 2019: sigue siendo de curso legal, pero muchos comercios lo rechazan.',
        'Deja USD/EUR fijado como favorito en {{app}} para tenerlo delante nada más abrirla.',
      ],
    },
    faq: [
      {
        q: '¿Hay que declarar el efectivo si llego a España con dólares?',
        a: 'Sí, a partir de 10.000 euros o su equivalente en cualquier divisa, incluidos los dólares estadounidenses, tanto al entrar como al salir de la Unión Europea. Es un trámite aduanero de declaración, no un impuesto.',
      },
      {
        q: '¿Sirve el mismo tipo USD/EUR en toda la zona euro?',
        a: 'Sí. El euro es una moneda única para todos los países de la zona euro, así que la conversión desde dólares es idéntica en Madrid, en Lisboa o en Tallin. Lo que cambia de un país a otro es el precio de las cosas, no el tipo de cambio.',
      },
    ],
  },

  'usd-mxn': {
    lead:
      'Un dólar estadounidense compra muchos pesos mexicanos, así que convertir USD a MXN devuelve siempre una cifra bastante mayor. '
      + 'Quien hace el cálculo es {{app}}, que aguanta sin cobertura: justo lo que falla en carretera y en la frontera.',
    h2: 'Quién convierte dólares estadounidenses a pesos mexicanos',
    body: [
      'USD/MXN es, antes que un par de mercado, el par de las remesas. El corredor Estados Unidos–México es el mayor del mundo en dinero enviado por particulares, con decenas de miles de millones de dólares al año que llegan sobre todo a Jalisco, Michoacán y Guanajuato, y que se cobran en pesos en ventanilla o en cuenta.',
      'En ese envío la tasa pesa más que la comisión. Muchas remesadoras anuncian tarifas bajas y recuperan el margen en el cambio que aplican, de modo que la única forma honesta de comparar dos servicios es mirar cuántos pesos llegan al final, no cuánto cuesta enviar. Conocer la referencia interbancaria antes de entrar en la agencia es lo que hace posible esa comparación.',
      'El par manda también en el turismo. En Cancún, Los Cabos o Puerto Vallarta muchos negocios aceptan billetes en dólares, pero al cambio que ellos mismos deciden. Y el peso mexicano cotiza prácticamente las veinticuatro horas: es la divisa más negociada de América Latina, y por eso se mueve incluso de madrugada, cuando México duerme.',
    ],
    tips: {
      h3: 'Notas prácticas para USD/MXN',
      items: [
        'Compara la tasa de la remesadora con la referencia interbancaria de {{app}}: esa distancia, más la comisión, es el coste real del envío.',
        'Dentro de México, paga en pesos. El comercio que acepta dólares fija su propio cambio y casi siempre sales perdiendo.',
        'Los cajeros mexicanos ofrecen cobrarte la retirada en dólares: rechaza esa conversión y pide la entrega en pesos.',
        'Las remesadoras cotizan distinto en fin de semana, cuando el mercado interbancario está cerrado y trabajan con una referencia vieja.',
        'Guarda la tasa en {{app}} antes de salir de cobertura: en carretera calcula con la última cifra almacenada.',
      ],
    },
    faq: [
      {
        q: '¿Conviene cobrar la remesa en efectivo o en cuenta bancaria?',
        a: 'Depende del operador: un mismo envío suele llevar tasas distintas según se pague en ventanilla o se abone en una cuenta mexicana. Compara los pesos que se reciben en cada caso y no la tasa anunciada en el escaparate.',
      },
      {
        q: '¿Se puede pagar en dólares dentro de México?',
        a: 'En zonas turísticas y fronterizas sí, pero al cambio que fija el propio establecimiento. Además, los bancos mexicanos limitan la cantidad de billetes en dólares que cambian a quien no es cliente, así que llevar pesos se ahorra el problema entero.',
      },
    ],
  },

  'eur-mad': {
    lead:
      'El dírham marroquí no es una moneda convertible fuera de Marruecos: se compra al llegar y hay un límite legal para sacarlo del país. '
      + 'El cálculo de EUR/MAD lo hace {{app}}, que guarda la última tasa y responde sin datos en itinerancia, ya en el puerto de llegada.',
    h2: 'Quién convierte euros a dírhams marroquíes',
    body: [
      'La marroquí es la mayor comunidad extranjera de España, y EUR/MAD es un par de vida cotidiana antes que de mercado: envíos a la familia en Nador, Tánger o Beni Mellal, compras de terreno y obra en el pueblo, y sobre todo el verano. Cada verano la Operación Paso del Estrecho llena de pasajeros y de vehículos los puertos de Algeciras, Tarifa, Almería y Motril rumbo a Tánger Med y Nador.',
      'El dírham no flota libremente. Bank Al-Maghrib lo gestiona frente a una cesta compuesta en un 60 % por el euro y en un 40 % por el dólar estadounidense, dentro de una banda de fluctuación que se amplió al ±5 % en marzo de 2020. En la práctica el par se mueve poco y despacio, y buena parte de lo que varía viene de lo que hace el euro contra el dólar, no de Marruecos.',
      'Eso desplaza la pregunta importante: no es cuál es la tasa, sino cuánto margen te cobra quien te cambia. Entre una ventanilla del puerto, un banco de la avenida y un cajero automático la diferencia es real y perfectamente visible, mientras que la referencia apenas varía de un día para otro.',
    ],
    tips: {
      h3: 'Notas prácticas para EUR/MAD',
      items: [
        'El dírham no se vende fuera de Marruecos: cambia al llegar y no pierdas tiempo pidiéndolo en tu banco en España.',
        'Al salir del país rige un límite legal de dírhams en efectivo por persona; gasta o recambia el sobrante antes de embarcar.',
        'Guarda los recibos del cambio: hacen falta para volver a convertir dírhams a euros en el aeropuerto o en el puerto.',
        'Ceuta y Melilla usan el euro, de modo que cruzar la frontera terrestre implica cambiar de moneda además de cambiar de país.',
        'Fuera de hoteles y grandes superficies el efectivo sigue mandando: calcula el importe en {{app}} antes de sacar dinero.',
      ],
    },
    faq: [
      {
        q: '¿Puedo comprar dírhams en España antes de viajar?',
        a: 'Prácticamente no. El dírham marroquí tiene convertibilidad restringida y no se negocia con normalidad fuera de Marruecos, así que lo habitual es llevar euros y cambiarlos al llegar, en el puerto, en el aeropuerto o en un banco.',
      },
      {
        q: '¿Por qué el EUR/MAD casi no se mueve?',
        a: 'Porque Bank Al-Maghrib no deja flotar el dírham: lo referencia a una cesta dominada por el euro, con el dólar como segundo componente, dentro de una banda estrecha. El resultado es una cotización muy estable, en la que el margen de la ventanilla pesa más que el mercado.',
      },
    ],
  },

  'eur-cop': {
    lead:
      'Convertir EUR a COP devuelve cifras de varios miles por cada euro, y ese salto de escala es la primera fuente de errores al enviar dinero a Colombia. '
      + 'La conversión la hace {{app}}, donde además se fija cuántos decimales quieres ver para leer importes tan largos sin equivocarte.',
    h2: 'Quién convierte euros a pesos colombianos',
    body: [
      'España es, después de Estados Unidos, el segundo origen de las remesas que entran en Colombia, y buena parte de ese dinero sale de Madrid, Barcelona y Valencia hacia el Valle del Cauca, Antioquia y Risaralda. Es un flujo mensual, atado a la nómina, y por eso el par se consulta con la misma regularidad con la que se cobra.',
      'Hay un detalle que despista a quien compara tasas desde Europa: en Colombia la referencia oficial no es la cotización del momento, sino la TRM, la tasa representativa del mercado que publica la Superintendencia Financiera y que se calcula con las operaciones del día hábil anterior. La TRM va siempre un paso por detrás, así que un banco colombiano y una plataforma española pueden enseñar números distintos sin que ninguno esté equivocado.',
      'La otra fuente de errores es la escritura. El punto separa los miles y la coma marca los decimales, los precios se dicen en miles y el peso conserva dos decimales en la norma ISO 4217 que en la calle ya no circulan. Un importe mal leído por un cero es el fallo más caro y más frecuente de este corredor.',
    ],
    tips: {
      h3: 'Notas prácticas para EUR/COP',
      items: [
        'Cuenta los ceros antes de confirmar: en pesos colombianos, un dígito de más o de menos multiplica o divide el envío por diez.',
        'Si tu familia compara con la TRM del día, recuerda que se calculó con las operaciones de la jornada anterior.',
        'Pregunta si la remesa se entrega en pesos o en dólares: algunos operadores pagan en dólares y la conversión final la hace la ventanilla.',
        'Los centavos de peso no circulan; ajusta los decimales en {{app}} para leer las cantidades de un vistazo.',
        'Enviar una vez al mes en lugar de cuatro reparte mejor la comisión fija sobre el total remitido.',
      ],
    },
    faq: [
      {
        q: '¿Qué es la TRM y por qué no coincide con la tasa de {{app}}?',
        a: 'La TRM es la tasa representativa del mercado que se publica cada día en Colombia y se obtiene de las operaciones del día hábil anterior entre pesos y dólares. {{app}} trabaja con una referencia interbancaria del momento, así que ambas cifras no tienen por qué coincidir.',
      },
      {
        q: '¿Por qué los precios colombianos llevan tantos ceros?',
        a: 'Porque el peso colombiano nunca se ha redenominado y un café o un pasaje de bus cuestan miles de pesos. La costumbre local es enunciar los precios en miles, de modo que conviene mirar todos los dígitos antes de convertir una cantidad.',
      },
    ],
  },

  'eur-gbp': {
    lead:
      'Una libra esterlina vale más que un euro, así que convertir EUR a GBP devuelve una cifra menor que la de partida. '
      + 'En {{app}} basta con invertir las dos monedas para comprobar el sentido, que es la manera más rápida de no leer el par al revés.',
    h2: 'Quién convierte euros a libras esterlinas',
    body: [
      'En España este par tiene un epicentro geográfico muy concreto: la Verja de Gibraltar. Cada día laborable miles de trabajadores cruzan desde La Línea de la Concepción y el resto del Campo de Gibraltar, cobran su nómina en libras y la gastan en euros al volver a casa. Para ellos EUR/GBP no es una consulta de viaje, es la conversión de su sueldo.',
      'Gibraltar añade una vuelta de tuerca: emite su propia libra gibraltareña, con código ISO 4217 GIP, a la par con la esterlina y en circulación junto a ella dentro del territorio. La paridad es fija, pero esos billetes no son de curso legal en el Reino Unido y bastantes comercios británicos los rechazan, así que conviene gastarlos o cambiarlos antes de salir del Peñón.',
      'El otro grupo grande es el de quien compra en tiendas británicas. Desde la salida del Reino Unido del mercado único, un pedido de Londres entra en España como importación: IVA español al recibirlo y, por encima del umbral, aranceles y gastos de gestión del transportista. El precio en libras pasado a euros ya no es el precio final.',
    ],
    tips: {
      h3: 'Notas prácticas para EUR/GBP',
      items: [
        'El mercado suele cotizar este par al revés, como GBP/EUR; comprueba en qué sentido está leída la cifra que te dan.',
        'Los billetes de Gibraltar, de Escocia y de Irlanda del Norte son libras del mismo valor, pero no todo comercio británico los admite.',
        'En el Reino Unido las etiquetas de tienda ya llevan el impuesto incluido, así que lo que ves es lo que pagas.',
        'Rechaza que el datáfono británico te cobre en euros: ese cambio lo pone el comercio y no tu banco.',
        'Deja EUR/GBP entre los favoritos de {{app}} si cruzas la Verja a diario.',
      ],
    },
    faq: [
      {
        q: '¿La libra de Gibraltar vale lo mismo que la esterlina?',
        a: 'Sí, la libra gibraltareña (GIP) está a la par con la esterlina y ambas circulan en el Peñón. La diferencia está en la aceptación: fuera de Gibraltar, y en particular en el Reino Unido, sus billetes no tienen curso legal y muchos comercios no los quieren.',
      },
      {
        q: '¿Qué pago de más al comprar en una web británica desde España?',
        a: 'Sobre el importe convertido se liquida el IVA español en la aduana, más los aranceles cuando el pedido rebasa el umbral aplicable y los gastos de gestión que factura la empresa de transporte. Súmalo todo antes de comparar con un precio nacional.',
      },
    ],
  },

  'eur-chf': {
    lead:
      'El franco suizo es una divisa refugio: tiende a apreciarse cuando los mercados se ponen nerviosos, y EUR/CHF se mueve cerca de la paridad. '
      + 'Del cálculo se encarga {{app}}, que retiene la última tasa descargada y sigue respondiendo en los valles alpinos sin red.',
    h2: 'Quién convierte euros a francos suizos',
    body: [
      'La colonia española en Suiza es una de las más antiguas de la emigración europea: llegó en los años sesenta y setenta y sigue siendo una de las colonias extranjeras con más arraigo del país. Se le han sumado ingenieros, personal sanitario, temporeros de estación de esquí y las empresas españolas que facturan a clientes suizos. Todos ellos cobran en francos y tienen gastos, hipoteca o familia en euros.',
      'El franco tiene una historia reciente que explica su fama. El Banco Nacional de Suiza sostuvo entre 2011 y 2015 un suelo para el euro y lo abandonó sin previo aviso en enero de 2015: el par se desplazó en minutos como no se había visto nunca en una divisa del G10 y dejó fuera de sus cálculos a mucha gente con préstamos en francos. Desde entonces flota, aunque el banco central interviene cuando la apreciación aprieta.',
      'Sobre el terreno hay una peculiaridad que sorprende: la moneda más pequeña en circulación es la de cinco céntimos, de modo que los pagos en efectivo se redondean a múltiplos de cinco. Y Suiza queda fuera de la Unión Europea y de su territorio aduanero, así que las compras cruzan una frontera fiscal de verdad en los dos sentidos.',
    ],
    tips: {
      h3: 'Notas prácticas para EUR/CHF',
      items: [
        'Los precios suizos se escriben con CHF delante y suelen acabar en cinco o en cero: las piezas de uno y dos céntimos ya no existen.',
        'Muchos comercios de zona turística aceptan euros, pero devuelven el cambio en francos y al tipo que ellos deciden.',
        'Suiza está fuera de la unión aduanera europea: al volver hay franquicias y umbrales que declarar en la frontera.',
        'Si cobras en francos y pagas una hipoteca en euros, mira el gráfico de cinco años de {{app}} antes de dar por normal el nivel actual.',
        'Liechtenstein también usa el franco suizo, con los mismos billetes y exactamente la misma cotización.',
      ],
    },
    faq: [
      {
        q: '¿Por qué el franco suizo sube cuando hay tensión en los mercados?',
        a: 'Porque los inversores lo tratan como valor refugio: Suiza tiene deuda pública baja, superávit exterior y moneda propia fuera de la zona euro. Cuando crece la incertidumbre aumenta la demanda de francos, y el par EUR/CHF baja.',
      },
      {
        q: '¿Puedo pagar en euros en Suiza?',
        a: 'En bastantes comercios de ciudad y en las estaciones sí, pero el cambio lo aplica el vendedor y la vuelta llega en francos. Pagar con tarjeta en francos, o sacarlos de un cajero, deja el importe mucho más cerca de la referencia.',
      },
    ],
  },

  'eur-dop': {
    lead:
      'El peso dominicano se escribe RD$, comparte símbolo con el dólar y en zona turística convive con precios en dólares estadounidenses, así que conviene mirar qué moneda estás convirtiendo. '
      + '{{app}} las mantiene separadas por su código ISO 4217, DOP y USD, y convierte a euros la que de verdad figura en el precio.',
    h2: 'Quién convierte euros a pesos dominicanos',
    body: [
      'España es el segundo país emisor de remesas hacia la República Dominicana, por detrás de Estados Unidos, y la comunidad dominicana lleva instalada en Madrid, Barcelona y Valencia desde los años ochenta. El envío mensual a Santo Domingo, Santiago o San Francisco de Macorís es el uso principal de este par.',
      'El segundo uso es el turismo. Punta Cana, Bayahíbe y Samaná concentran a la mayoría de los viajeros españoles que llegan al país, y allí conviven dos monedas: hoteles, excursiones y buena parte de los restaurantes anuncian en dólares estadounidenses, mientras que el colmado, la guagua y el taxi funcionan en pesos. Pagar con tarjeta un precio anunciado en dólares implica dos conversiones encadenadas.',
      'En la cuenta de un restaurante dominicano hay además dos añadidos que conviene conocer antes de convertir: el ITBIS, el impuesto sobre transferencias de bienes industrializados y servicios, y la propina legal del diez por ciento que la normativa laboral fija para la hostelería. Lo que hay que pasar a euros es el total del ticket, nunca el precio de la carta.',
    ],
    tips: {
      h3: 'Notas prácticas para EUR/DOP',
      items: [
        'Comprueba si el precio está en RD$ o en US$: en zona turística conviven los dos y el símbolo es casi idéntico.',
        'Antes de pagar en un restaurante se suman el ITBIS y la propina legal; convierte el total del ticket.',
        'El cambio del aeropuerto suele ser el peor del viaje; los bancos y cajeros de ciudad se acercan mucho más a la referencia.',
        'Fuera de los complejos turísticos casi todo se paga en efectivo y en pesos: calcula el importe antes de sacar dinero.',
        'Deja EUR/DOP guardado en los favoritos de {{app}} si envías dinero todos los meses.',
      ],
    },
    faq: [
      {
        q: '¿Llevo euros, dólares o pesos a la República Dominicana?',
        a: 'Euros para cambiarlos allí, o tarjeta. Pasar euros a pesos en un banco dominicano suele salir mejor que comprar dólares en España para volver a cambiarlos en destino, porque cada conversión intermedia añade un margen nuevo.',
      },
      {
        q: '¿Por qué la cuenta del restaurante sube respecto a lo que marca la carta?',
        a: 'Porque se le añaden el ITBIS y la propina legal del diez por ciento prevista en la normativa laboral dominicana. Son cargos habituales y esperables, así que conviene convertir el total y no el precio del plato.',
      },
    ],
  },

  'eur-pen': {
    lead:
      'El sol peruano es una de las monedas más estables de América del Sur, así que EUR/PEN varía menos que la mayoría de los pares latinoamericanos. '
      + 'Quien pone la cifra es {{app}}, gratis en Android e iOS, con la fecha de la tasa siempre a la vista.',
    h2: 'Quién convierte euros a soles peruanos',
    body: [
      'La comunidad peruana en España está entre las latinoamericanas más asentadas y se concentra en Madrid, Barcelona y Valencia. De ahí sale buena parte de las remesas que llegan al Perú, con destino a Lima, La Libertad y Áncash, y con un ritmo mensual que sigue al día de cobro mucho más que al mercado.',
      'La moneda esconde un detalle que despista en los buscadores: hasta diciembre de 2015 se llamaba nuevo sol y desde entonces se llama simplemente sol, aunque el código ISO 4217 siguió siendo PEN y el símbolo S/ tampoco cambió. Todavía se encuentran webs y contratos con el nombre antiguo, y se refieren exactamente a la misma moneda.',
      'El Banco Central de Reserva del Perú interviene con regularidad en el mercado cambiario para suavizar los movimientos bruscos, y esa política es la razón de que el sol lleve años entre las divisas menos volátiles de la región. Para quien manda dinero eso significa que el margen del operador pesa más que la fecha elegida: esperar una semana rara vez compensa una tasa peor.',
    ],
    tips: {
      h3: 'Notas prácticas para EUR/PEN',
      items: [
        'Nuevo sol y sol son la misma moneda: el nombre se acortó en 2015 y el código PEN se mantuvo intacto.',
        'En el Perú el dólar convive con el sol en pisos y alquileres; confirma en qué moneda está el precio antes de convertir.',
        'Las casas de cambio autorizadas de Lima suelen dar mejor tasa que el mostrador del aeropuerto o el del hotel.',
        'Los billetes muy deteriorados o rasgados se rechazan con frecuencia: revísalos al recibir el cambio.',
        'Pon EUR/PEN entre tus favoritos en {{app}} para verlo nada más abrir la aplicación.',
      ],
    },
    faq: [
      {
        q: '¿Es lo mismo el sol que el nuevo sol?',
        a: 'Sí. El Perú retiró el adjetivo del nombre de su moneda a finales de 2015, pero no tocó ni el código ISO 4217, que sigue siendo PEN, ni el símbolo S/. Cualquier precio expresado en nuevos soles es un precio en soles.',
      },
      {
        q: '¿Conviene esperar a que mejore la tasa para enviar dinero al Perú?',
        a: 'Rara vez. El sol figura entre las monedas más estables de la región porque su banco central suaviza los movimientos, de modo que la variación de una semana suele ser menor que la diferencia de margen entre dos operadores de envío.',
      },
    ],
  },

  'eur-ars': {
    lead:
      'El peso argentino ha convivido durante años con varias cotizaciones simultáneas del dólar y con inflación alta, así que las cifras de EUR/ARS envejecen deprisa. '
      + '{{app}} fecha cada tasa que descarga, de modo que se ve al momento si la que tienes delante es de hoy o del mes pasado.',
    h2: 'Quién convierte euros a pesos argentinos',
    body: [
      'El corredor España–Argentina tiene una particularidad: circula en los dos sentidos y con mucha gente que lleva los dos pasaportes. La ley española de memoria democrática abrió a partir de 2022 un plazo para pedir la nacionalidad por descendencia, y Argentina fue con diferencia el país con más solicitudes. El resultado es una comunidad argentina creciente en Madrid y Barcelona que conserva familia, alquileres y trámites en Buenos Aires.',
      'Al otro lado, el viajero español se encuentra con un sistema de precios en movimiento. Durante años convivieron un tipo oficial y varias cotizaciones paralelas o financieras, y los consumos con tarjeta en el exterior han estado sujetos a percepciones impositivas que cambian con la normativa. Antes de viajar conviene preguntar qué tipo aplica el banco a cada operación, porque la respuesta ha cambiado varias veces en la última década.',
      'La otra herencia visible es la de los ceros. El peso actual resulta de sucesivas reformas monetarias —peso ley, peso argentino, austral y peso convertible— que entre 1970 y 1992 suprimieron trece ceros en total. Por eso los importes históricos no se comparan directamente, y los centavos, aunque existen en la norma ISO 4217, hace tiempo que no se ven.',
    ],
    tips: {
      h3: 'Notas prácticas para EUR/ARS',
      items: [
        'Mira la marca de tiempo antes de fiarte de una cifra: en este par una referencia de hace semanas ya no sirve de nada.',
        'Pregunta a tu banco qué recargos aplica a los consumos con tarjeta en Argentina; la normativa ha cambiado varias veces.',
        'Los importes argentinos se escriben con punto para los miles y coma para los decimales, al contrario que en inglés.',
        'Los centavos no circulan: en efectivo los precios se redondean al peso entero.',
        'El gráfico de cinco años de {{app}} enseña de un vistazo por qué este par no se puede memorizar.',
      ],
    },
    faq: [
      {
        q: '¿Por qué he visto cotizaciones distintas del peso argentino el mismo día?',
        a: 'Porque Argentina ha tenido durante largos periodos un tipo oficial conviviendo con cotizaciones paralelas o financieras, cada una con su propio uso. {{app}} trabaja con una referencia de mercado fechada, no con un tipo oficial ni con el de una casa de cambio concreta.',
      },
      {
        q: '¿Cuántos ceros se le han quitado al peso argentino?',
        a: 'Trece en total entre 1970 y 1992, repartidos en cuatro reformas monetarias: el peso ley, el peso argentino, el austral y el peso convertible. Es la razón de que la cifra de un contrato antiguo no se pueda convertir sin saber en qué moneda estaba expresada.',
      },
    ],
  },

  'eur-mxn': {
    lead:
      'Convertir EUR a MXN interesa a dos públicos distintos: quien viaja o hace negocios entre España y México, y quien manda dinero a casa. '
      + 'Los dos acaban en {{app}}, que resuelve el par en el móvil y sigue haciéndolo sin red, con la fecha de la última tasa junto a la cifra.',
    h2: 'Quién convierte euros a pesos mexicanos',
    body: [
      'España figura entre los mayores inversores extranjeros en México, y hay miles de filiales, contratos y nóminas que cruzan el Atlántico en euros para gastarse en pesos. A eso se suman los estudiantes mexicanos en universidades españolas, con matrícula en euros y presupuesto familiar en pesos, y un turismo de ida y vuelta con vuelo directo diario entre Madrid y Ciudad de México.',
      'El peso mexicano no es una divisa cualquiera de la región: se negocia casi las veinticuatro horas y es la moneda emergente más líquida de América Latina, lo que la ha convertido en el instrumento con el que los mercados expresan su humor sobre todo el continente. En la práctica significa que el par puede desplazarse de madrugada por noticias que no tienen nada que ver con México.',
      'Sobre el terreno, la confusión más frecuente es la del símbolo. Los precios mexicanos se escriben con el signo de dólar, y para distinguirlos se añade a veces M.N., de moneda nacional, o el código MXN. Leer una etiqueta como si estuviera en dólares estadounidenses multiplica la factura mental, sobre todo donde se anuncian las dos monedas a la vez.',
    ],
    tips: {
      h3: 'Notas prácticas para EUR/MXN',
      items: [
        'Un precio con el signo de dólar en México casi siempre es en pesos: busca M.N. o el código MXN para confirmarlo.',
        'En la Riviera Maya, paga en pesos aunque el precio esté anunciado en dólares estadounidenses.',
        'El par se mueve fuera del horario europeo, así que la cifra de la mañana puede no ser la de la tarde.',
        'Los billetes mexicanos se diferencian por tamaño además de por color, algo útil al pagar en efectivo y con prisa.',
        'Añade EUR/MXN a los favoritos de {{app}} si facturas o estudias entre los dos países.',
      ],
    },
    faq: [
      {
        q: '¿El signo de dólar en un precio mexicano significa dólares?',
        a: 'Casi nunca. En México ese signo se usa para el peso, y cuando hay riesgo de confusión se añade M.N. o el código MXN. En las zonas donde se anuncian ambas monedas, la etiqueta en divisa extranjera suele indicar USD de forma explícita.',
      },
      {
        q: '¿Por qué cambia el EUR/MXN cuando en México es de noche?',
        a: 'Porque el peso mexicano se negocia prácticamente sin interrupción en los mercados internacionales y es la divisa emergente más líquida de América Latina. Los operadores la usan para tomar posiciones sobre la región entera, así que reacciona a noticias de fuera del país.',
      },
    ],
  },

  'eur-bob': {
    lead:
      'El boliviano lleva más de una década con un tipo oficial fijo frente al dólar, así que EUR/BOB se mueve sobre todo con el EUR/USD. '
      + 'La conversión se hace en {{app}}, con una tasa fechada que queda guardada en el teléfono para usarla donde no llega la señal.',
    h2: 'Quién convierte euros a bolivianos',
    body: [
      'La emigración boliviana a España se concentró entre 2004 y 2007, sobre todo desde Cochabamba y Santa Cruz, y dejó en España una comunidad boliviana bien asentada. Dos décadas después el par se consulta para lo de siempre: el envío mensual a casa y la construcción o la compra de terreno en el departamento de origen.',
      'Lo que distingue a este corredor es que el boliviano no flota. El Banco Central de Bolivia sostiene desde 2011 un tipo de cambio oficial estable frente al dólar estadounidense, con precios de compra y de venta que apenas se han tocado. Como el euro sí flota contra el dólar, este par es en realidad un cruce: cuando la cifra cambia, casi siempre es porque se ha movido el euro y no el boliviano.',
      'La contrapartida es que la escasez de divisas en el mercado interno boliviano de los últimos años ha hecho que conseguir billetes en dólares dentro del país resulte más difícil y más caro que el tipo oficial. Para quien envía dinero desde España la consecuencia práctica es directa: importa mucho en qué moneda se entrega la remesa y quién aplica la conversión final.',
    ],
    tips: {
      h3: 'Notas prácticas para EUR/BOB',
      items: [
        'Al ser estable el tipo oficial del boliviano frente al dólar, el margen del operador es prácticamente todo el coste del envío.',
        'Pregunta si la remesa se abona en bolivianos o en dólares: para quien la cobra no es en absoluto lo mismo.',
        'Los precios se escriben con Bs delante del importe, y el boliviano tiene dos decimales que sí circulan en moneda fraccionaria.',
        'Fuera de las ciudades grandes manda el efectivo: calcula antes de salir con {{app}}, que funciona con los datos apagados.',
        'Compara varios operadores el mismo día: como la cotización no se mueve, la diferencia entre ellos se ve limpia.',
      ],
    },
    faq: [
      {
        q: '¿Por qué se mueve el EUR/BOB si el boliviano está fijado al dólar?',
        a: 'Porque el par es un cruce. El Banco Central de Bolivia mantiene el boliviano estable frente al dólar estadounidense, pero el euro sí flota contra ese mismo dólar, así que la variación que ves entre euros y bolivianos viene del lado europeo.',
      },
      {
        q: '¿En qué moneda conviene enviar dinero a Bolivia?',
        a: 'Depende del destino del dinero. Si se va a gastar en el día a día, cobrarlo en bolivianos evita una conversión intermedia; si se va a guardar, muchas familias prefieren dólares. Lo que no conviene es descubrirlo delante de la ventanilla.',
      },
    ],
  },
},

  de: {
  'eur-chf': {
    lead:
      'Euro (EUR) und Schweizer Franken (CHF) rechnet {{app}} in beide Richtungen um – gratis für Android und iOS, im Grenzgebiet auch ohne Netz. '
      + 'An dieser einen Zahl hängt für Zehntausende Grenzgänger jeden Monat, was das Schweizer Gehalt auf der deutschen Seite der Grenze wert ist.',
    h2: 'Wer Euro in Schweizer Franken umrechnet',
    body: [
      'Mehr als 60.000 Menschen aus Deutschland arbeiten als Grenzgänger in der Schweiz, die meisten aus den Landkreisen Lörrach, Waldshut und Konstanz. Ihr Lohn kommt in Franken, Miete, Kita und Wocheneinkauf laufen in Euro. Wer monatlich überweist, tauscht zwölfmal im Jahr — ein paar Rappen Unterschied je Franken summieren sich über diese zwölf Termine zu einem Betrag, der eine Monatsmiete erreichen kann.',
      'In die Gegenrichtung fährt der Einkaufstourismus. Schweizer Haushalte kaufen in Weil am Rhein, Lörrach oder Konstanz ein und lassen sich die deutsche Mehrwertsteuer über die Ausfuhrbescheinigung erstatten; seit 2020 verlangt der deutsche Zoll dafür einen Rechnungsbetrag von mindestens 50 Euro. Auf Schweizer Seite gilt eine Wertfreigrenze von 150 Franken pro Person und Tag, darüber wird eingeführt und verzollt. Beide Grenzen sind in Franken beziehungsweise Euro festgeschrieben — was sich verschiebt, ist der Kurs dazwischen.',
      'Der Franken gilt außerdem als sicherer Hafen. Als die Schweizerische Nationalbank im Januar 2015 ihren Mindestkurs zum Euro fallen ließ, verschob sich das Paar binnen Minuten so stark, dass Grenzgänger und Kreditnehmer die Folgen jahrelang spürten.',
    ],
    tips: {
      h3: 'Praxis-Hinweise zu EUR/CHF',
      items: [
        'Bargeld wird in der Schweiz auf fünf Rappen gerundet; kleinere Münzen als das Fünfrappenstück sind nicht mehr im Umlauf.',
        'Grenzgängerkonten rechnen den Lohn zu einem Hauskurs um. Vergleichen Sie diesen Hauskurs mit dem Referenzkurs, bevor Sie einen Dauerauftrag einrichten.',
        'Schweizer Kartenterminals bieten oft die Abrechnung in Euro an; in Franken zu zahlen liegt fast immer näher am Markt.',
        'Der Franken wertet in Krisen auf, ohne dass es in Deutschland eine Nachricht dazu gäbe — der Auslöser liegt meist außerhalb beider Länder.',
      ],
    },
    faq: [
      {
        q: 'Soll ich den Franken-Lohn sofort oder erst später nach Deutschland überweisen?',
        a: 'Wer wartet, geht bewusst ein Kursrisiko ein; wer jeden Monat zum selben Termin wechselt, mittelt den Kurs über das Jahr. Größer als der Zeitpunkt ist meist die Marge, die die Bank auf den Referenzkurs legt.',
      },
      {
        q: 'Kann ich in der Schweiz mit Euro bezahlen?',
        a: 'Viele Geschäfte in Grenznähe nehmen Euro-Scheine an, setzen den Kurs aber selbst fest und geben das Wechselgeld in Franken zurück. Der Aufschlag liegt in der Regel deutlich über den Kosten einer Kartenzahlung in Franken.',
      },
    ],
  },

  'eur-usd': {
    lead:
      'Ein Euro (EUR) ist mehr wert als ein US-Dollar (USD), eine Umrechnung von EUR in USD ergibt also eine größere Zahl als den Ausgangsbetrag. '
      + 'Beide Richtungen rechnet {{app}} auf dem Telefon, notfalls mit den zuletzt gespeicherten Kursen.',
    h2: 'Wer Euro in US-Dollar umrechnet',
    body: [
      'Für Reisende ist die USA-Rechnung eine Falle mit zwei Stufen. Amerikanische Preisschilder sind Nettopreise: Die Sales Tax kommt erst an der Kasse dazu und unterscheidet sich nicht nur je Bundesstaat, sondern oft je Stadt. Dazu kommt das Trinkgeld, das im Restaurant als Teil des Preises gilt. Wer den Schildpreis umrechnet, kalkuliert regelmäßig zu niedrig.',
      'Der zweite große Anlass steht im Depot. Deutsche Kleinanleger halten ihre Aktienquote überwiegend in Welt-Indizes, deren größter Block auf amerikanische Titel entfällt. Dass ein Fondsanteil in Euro notiert, bedeutet nicht, dass er in Euro abgesichert ist: Die Notierungswährung sagt nichts über die Anlagewährung. Ein Depotauszug in Euro bewegt sich deshalb auch dann, wenn an den amerikanischen Börsen gar nichts passiert ist.',
      'Für die Einordnung nützlich: Die Europäische Zentralbank veröffentlicht an jedem Geschäftstag gegen 16 Uhr ihre Euro-Referenzkurse, ermittelt in einer Abstimmung der Notenbanken am frühen Nachmittag. Diese Kurse sind Mittelkurse ohne Aufschlag — genau wie der Referenzkurs in {{app}} und anders als jeder Kurs, zu dem tatsächlich getauscht wird.',
    ],
    tips: {
      h3: 'Praxis-Hinweise zu EUR/USD',
      items: [
        'Rechnen Sie in den USA den Endbetrag um, nicht den Preis auf dem Etikett: Steuer und Trinkgeld stehen dort nicht drauf.',
        'Wenn ein amerikanisches Terminal die Abrechnung in Euro anbietet, ist das eine Umrechnung des Händlers. Die Zahlung in Dollar liegt näher am Referenzkurs.',
        'Viele deutsche Kartenherausgeber berechnen auf Zahlungen außerhalb des Euroraums zusätzlich ein Auslandseinsatzentgelt, meist zwischen 1 und 2 Prozent des Betrags.',
        'Das Paar reagiert auf die Sitzungen von EZB und Federal Reserve, deren Termine ein Jahr im Voraus feststehen.',
      ],
    },
    faq: [
      {
        q: 'Warum weicht der Kurs auf meiner Kreditkartenabrechnung von dem in {{app}} ab?',
        a: 'Das Kartensystem rechnet zum Kurs des Abrechnungstages um, nicht zum Kurs des Einkaufs, und die kartenausgebende Bank legt ihr Auslandseinsatzentgelt darauf. Beide Zahlen bauen auf dem Interbanken-Referenzkurs auf, den {{app}} anzeigt.',
      },
      {
        q: 'Wann bewegt sich EUR/USD am stärksten?',
        a: 'An den Zinsentscheidungen von EZB und Federal Reserve sowie bei den amerikanischen Arbeitsmarkt- und Inflationsdaten. Die Veröffentlichungstermine sind lange vorher bekannt, die Reaktion des Marktes erfolgt innerhalb von Sekunden.',
      },
    ],
  },

  'eur-try': {
    lead:
      'Ein Euro entspricht sehr vielen Türkischen Lira, weshalb die Umrechnung von EUR in TRY eine um Größenordnungen höhere Zahl ergibt. '
      + 'Weil die Lira anhaltend an Kaufkraft verliert, taugt ein vor Wochen notierter Kurs selten noch — {{app}} lädt mehrmals am Tag neue nach.',
    h2: 'Wer Euro in Türkische Lira umrechnet',
    body: [
      'In Deutschland leben etwa drei Millionen Menschen mit türkischer Familiengeschichte, und dieses Paar begleitet ihren Alltag: Unterstützung für Verwandte, ein Hausbau in Anatolien, die Nebenkosten einer Wohnung an der Ägäis, der Sommerurlaub in der alten Heimat. In die Gegenrichtung fließen deutsche Renten auf türkische Konten.',
      'Die hohe türkische Teuerung verändert die Rechnung grundsätzlich. Preise in Lira werden laufend nach oben angepasst, weshalb ein Hotelpreis aus dem Winter im Sommer nicht mehr gilt und ein gemerkter Kurs schnell nichts mehr taugt. Viele Hotels, Ausflugsanbieter und Läden in Antalya oder Istanbul zeichnen deshalb gleich in Euro aus — und legen dabei einen Kurs zugrunde, den sie selbst bestimmen.',
      'Beim Geldtransfer entscheidet nicht die genannte Gebühr, sondern der Abstand zwischen dem Referenzkurs und dem Kurs des Anbieters. Am Wochenende, wenn der Devisenhandel ruht, fällt dieser Abstand meist größer aus, weil der Anbieter das Risiko einer Bewegung am Montag einpreist.',
    ],
    tips: {
      h3: 'Praxis-Hinweise zu EUR/TRY',
      items: [
        'Türkische Wechselstuben, die Döviz-Büros, nennen Ankauf und Verkauf getrennt; die Spanne dazwischen ist der eigentliche Preis des Tauschs.',
        'Geldautomaten in der Türkei fragen nachdrücklich nach einer Abrechnung in Euro — lehnen Sie die Umrechnung am Automaten ab.',
        'Die Lira hat 2005 sechs Nullen verloren. Beträge aus älteren Quellen lassen sich nicht ohne Weiteres vergleichen.',
        'Der Kuruş existiert offiziell weiter, spielt bei den heutigen Beträgen im Alltag aber keine Rolle mehr.',
      ],
    },
    faq: [
      {
        q: 'Euro-Bargeld mitnehmen oder in der Türkei am Automaten abheben?',
        a: 'Beides funktioniert. Ein Döviz-Büro in der Innenstadt rechnet meist enger am Referenzkurs ab als der Schalter am Flughafen, während der Automat eine feste Gebühr nimmt und zusätzlich seine eigene Umrechnung anbietet.',
      },
      {
        q: 'Warum bekomme ich bei einer Überweisung so viel weniger, als der Referenzkurs vermuten lässt?',
        a: 'Der Anbieter rechnet zu seinem eigenen Kurs um, und diese Marge steckt bereits im angezeigten Betrag. Vergleichen Sie deshalb immer die tatsächlich ankommende Summe in Lira, nicht die beworbene Gebühr.',
      },
    ],
  },

  'eur-pln': {
    lead:
      'Ein Euro entspricht mehreren Polnischen Złoty, die Umrechnung von EUR in PLN ergibt daher eine deutlich größere Zahl als der Ausgangsbetrag. '
      + 'Polen gehört zur EU, hat den Euro aber nicht eingeführt: An der Kasse in Stettin oder Słubice zählt allein der Złoty.',
    h2: 'Wer Euro in Polnische Złoty umrechnet',
    body: [
      'Entlang der Oder und der Neiße ist dieses Paar Alltagswissen. Aus Frankfurt (Oder) geht man zum Einkaufen nach Słubice, aus Görlitz nach Zgorzelec, aus Vorpommern nach Świnoujście — für Tanken, Zigaretten, Frisör, Zahnarzt und Wochenmarkt. In der anderen Richtung leben mehr als 800.000 polnische Staatsangehörige in Deutschland, von denen viele regelmäßig Geld nach Hause schicken.',
      'Der Złoty hat 100 Groszy und wird als zł geschrieben. Wechselstuben heißen kantor und nennen zwei Zahlen: kupno für den Ankauf, sprzedaż für den Verkauf. Der Abstand zwischen beiden ist die Gebühr, auch wenn nirgends „Gebühr“ steht. Grenznahe Geschäfte nehmen zwar Euro-Scheine, rechnen dabei aber zu einem Hauskurs um und geben Wechselgeld in Złoty heraus.',
      'Kartenzahlung ist in Polen selbstverständlich, das heimische System BLIK ebenso. Wer über die Autobahnen A1, A2 oder A4 fährt, zahlt auf den privat betriebenen Abschnitten Maut in Złoty. Die Nationalbank NBP verfolgt kein Kursziel gegenüber dem Euro; der Złoty schwankt frei, ein Beitrittsdatum zur Währungsunion gibt es nicht.',
    ],
    tips: {
      h3: 'Praxis-Hinweise zu EUR/PLN',
      items: [
        'Ein kantor in Polen rechnet in der Regel enger am Markt ab als eine Sortenbestellung bei der deutschen Hausbank.',
        'Bei Kartenzahlungen die Abrechnung in Złoty wählen und die angebotene Euro-Variante ablehnen.',
        'Auf den mautpflichtigen Abschnitten der A1, A2 und A4 wird in Złoty kassiert, je nach Betreiber bar oder per App.',
        'Polnische Onlineshops zeichnen in Złoty aus; der Endbetrag hängt am Kurs des Tages, an dem die Karte belastet wird.',
      ],
    },
    faq: [
      {
        q: 'Warum nennt ein polnischer kantor zwei verschiedene Kurse?',
        a: 'kupno ist der Kurs, zu dem er Ihnen Devisen abkauft, sprzedaż der Kurs, zu dem er sie verkauft. Der Interbanken-Referenzkurs liegt zwischen beiden; der Abstand nach außen ist die Vergütung der Wechselstube.',
      },
      {
        q: 'Lohnt sich das Tanken in Polen noch?',
        a: 'Das hängt an zwei Größen zugleich: am Literpreis in Złoty und am Kurs. Rechnen Sie den aktuellen Literpreis um, statt sich auf eine Faustregel zu verlassen — bei starkem Złoty schrumpft der Vorteil merklich.',
      },
    ],
  },

  'eur-uah': {
    lead:
      'Bei der Umrechnung von Euro in Ukrainische Hrywnja entsteht eine deutlich größere Zahl, weil ein Euro vielen Hrywnja entspricht. '
      + 'Der Kurs bildet sich als Kreuzkurs über den US-Dollar: Die Nationalbank der Ukraine steuert das Verhältnis zum Dollar, EUR/UAH ergibt sich daraus.',
    h2: 'Wer Euro in Ukrainische Hrywnja umrechnet',
    body: [
      'Seit 2022 leben über eine Million Menschen aus der Ukraine in Deutschland, und für sie ist dieses Paar keine Reisefrage, sondern Buchhaltung zwischen zwei Ländern. Was kostet eine Rechnung in Kyjiw, gemessen am Kindergeld in Euro? Wie viel bleibt den Eltern in Lwiw von einer Überweisung? Wie viel ist die Miete für die Wohnung wert, die weiterhin bezahlt wird?',
      'Praktisch stößt man dabei sofort auf eine Hürde: Deutsche Banken und Wechselstuben kaufen Hrywnja-Scheine so gut wie nie an. Bargeld, das jemand mitgebracht hat, lässt sich hier kaum tauschen. Der Weg läuft stattdessen über ukrainische Bank-Apps, Kartentransfers und Transferdienste — und dort entscheidet nicht die ausgewiesene Gebühr, sondern der Abstand zum Referenzkurs.',
      'Die Nationalbank der Ukraine hat den Kurs nach Kriegsbeginn fest an den Dollar gebunden und ist im Oktober 2023 zu einer gesteuerten Beweglichkeit übergegangen. Seither bewegt sich die Hrywnja in kleinen Schritten statt in Sprüngen, und zwischen dem amtlichen Kurs und dem Bargeldkurs in einem Kyjiwer Wechselbüro liegt regelmäßig ein Abstand.',
    ],
    tips: {
      h3: 'Praxis-Hinweise zu EUR/UAH',
      items: [
        'Hrywnja-Bargeld lässt sich in Deutschland fast nirgends eintauschen; planen Sie Beträge deshalb als Überweisung, nicht als Scheine.',
        'Die Nationalbank der Ukraine veröffentlicht arbeitstäglich einen amtlichen Kurs, von dem der Bargeldkurs vor Ort abweichen kann.',
        'Bewegt sich der Dollar zum Euro, bewegt sich EUR/UAH mit — auch wenn in der Ukraine selbst nichts geschehen ist.',
        'Die kleinsten Kopijka-Münzen wurden 2019 aus dem Verkehr gezogen; Barbeträge werden deshalb gerundet, Kartenzahlungen nicht.',
      ],
    },
    faq: [
      {
        q: 'Kann ich Hrywnja-Bargeld in Deutschland umtauschen?',
        a: 'In aller Regel nicht. Deutsche Banken und Wechselstuben führen die Hrywnja kaum im Sortenangebot, weil sie die Scheine nicht zurückgeben können. Übrig bleiben Überweisungen und Kartentransfers auf ein ukrainisches Konto.',
      },
      {
        q: 'Warum ändert sich EUR/UAH, obwohl die Nationalbank nichts entschieden hat?',
        a: 'Weil dieses Paar ein Kreuzkurs ist. Die Hrywnja wird gegenüber dem US-Dollar gesteuert; der Euro schwankt frei gegen den Dollar. Jede Bewegung von EUR/USD schlägt daher unmittelbar auf EUR/UAH durch.',
      },
    ],
  },

  'eur-gbp': {
    lead:
      'Ein Euro entspricht weniger als einem Britischen Pfund, deshalb liefert die Umrechnung von EUR in GBP eine kleinere Zahl als den Ausgangsbetrag. '
      + 'Wer die Reihenfolge der Codes verwechselt, liest das Paar verkehrt herum; in {{app}} lassen sich die beiden Seiten mit einem Tipp vertauschen.',
    h2: 'Wer Euro in Britische Pfund umrechnet',
    body: [
      'Seit dem Brexit ist eine Bestellung bei einem britischen Händler eine Einfuhr. Auf Warenwert und Versand fallen 19 Prozent Einfuhrumsatzsteuer an, ab 150 Euro Warenwert kommt Zoll hinzu, und der Paketdienst berechnet für die Abwicklung eine eigene Auslagepauschale. Der umgerechnete Preis auf der britischen Seite ist damit nur der Anfang der Rechnung.',
      'Umgekehrt enthält ein britisches Preisschild 20 Prozent VAT. Beim Versand in die EU sollte der Shop diese Steuer abziehen, sonst zahlen Sie zweimal Umsatzsteuer. Wer den Bruttopreis der Website nimmt und umrechnet, schätzt die Bestellung also zu hoch ein — und wer die Nebenkosten vergisst, zu niedrig.',
      'Für Reisen ist die Lage einfacher geworden: In London ist kontaktloses Bezahlen der Normalfall, im Nahverkehr ohnehin. Banknoten aus Schottland und Nordirland begegnen einem im Norden regelmäßig; es ist dasselbe Pfund zum selben Kurs, auch wenn Läden in England sie gelegentlich nicht kennen.',
    ],
    tips: {
      h3: 'Praxis-Hinweise zu EUR/GBP',
      items: [
        'Prüfen Sie vor der Bestellung, ob der britische Shop die VAT für den Export abzieht; sonst tragen Sie Steuer doppelt.',
        'Einfuhrumsatzsteuer fällt ab dem ersten Euro an, Zoll erst ab 150 Euro Warenwert — beides gemessen am umgerechneten Betrag.',
        'Die Auslagepauschale des Zustellers taucht in keinem Umrechnungsergebnis auf, verteuert die Sendung aber real.',
        'Schottische und nordirische Banknoten sind dasselbe Pfund und werden zum selben Kurs gerechnet.',
      ],
    },
    faq: [
      {
        q: 'Was kostet eine Bestellung aus Großbritannien am Ende wirklich?',
        a: 'Warenwert und Versand umgerechnet in Euro, darauf 19 Prozent Einfuhrumsatzsteuer, ab 150 Euro Warenwert zusätzlich Zoll, plus die Auslagepauschale des Paketdienstes. Nur der erste dieser vier Posten steht im Onlineshop.',
      },
      {
        q: 'Warum steht der Pfundkurs in den Nachrichten oft andersherum?',
        a: 'Am Devisenmarkt ist beides üblich: EUR/GBP nennt Pfund je Euro, GBP/EUR Euro je Pfund. Entscheidend ist die Reihenfolge der Codes, nicht die Gewohnheit der Redaktion — und umdrehen lässt sie sich in {{app}} mit einem Fingertipp.',
      },
    ],
  },

  'eur-czk': {
    lead:
      'Ein Euro entspricht vielen Tschechischen Kronen, weshalb die Umrechnung von EUR in CZK eine deutlich größere Zahl ergibt. '
      + 'Bar wird in Tschechien auf ganze Kronen gerundet: Heller sind seit 2008 nicht mehr im Umlauf, obwohl ISO 4217 zwei Nachkommastellen führt.',
    h2: 'Wer Euro in Tschechische Kronen umrechnet',
    body: [
      'Aus Sachsen und Bayern ist Tschechien ein Tagesausflug: Prag, Karlsbad, Eger, die Skigebiete im Riesengebirge, dazu Tanken und Einkaufen kurz hinter der Grenze. Umgekehrt pendeln viele tschechische Beschäftigte in die Oberpfalz und ins sächsische Grenzland und rechnen ihren Euro-Lohn in Kronen zurück.',
      'Berüchtigt sind die Wechselstuben der Prager Innenstadt, die mit „0 % Provision“ werben und den Kurs stattdessen weit vom Markt entfernt ansetzen. Seit 2019 schützt ein Gesetz dagegen: Ein Umtausch bis zum Gegenwert von 1.000 Euro lässt sich innerhalb von drei Stunden rückgängig machen, und die Wechselstube muss vorab einen Beleg mit dem Betrag aushändigen, den Sie erhalten werden.',
      'Die Tschechische Nationalbank hat ihre Wechselkursverpflichtung gegenüber dem Euro im April 2017 beendet; seither schwankt die Krone frei, ein Beitrittstermin zur Eurozone steht nicht im Raum. Restaurants und Läden in Touristenlagen nehmen zwar Euro an, legen den Kurs aber selbst fest und geben Wechselgeld in Kronen zurück.',
    ],
    tips: {
      h3: 'Praxis-Hinweise zu EUR/CZK',
      items: [
        'Ein Angebot „ohne Provision“ sagt nichts über den Kurs. Vergleichen Sie den ausgezahlten Betrag mit dem Referenzkurs.',
        'Der gesetzliche Rücktritt binnen drei Stunden gilt für Umtäusche bis zum Gegenwert von 1.000 Euro.',
        'Barbeträge werden auf ganze Kronen gerundet, Kartenzahlungen dagegen auf zwei Stellen genau abgerechnet.',
        'Wenn ein Terminal die Abrechnung in Euro vorschlägt, wählen Sie Kronen — die Händlerumrechnung kostet mehr.',
      ],
    },
    faq: [
      {
        q: 'Wie viel Bargeld brauche ich in Tschechien?',
        a: 'Wenig. Karten werden fast überall genommen, Bargeld lohnt sich für Märkte, Parkautomaten und kleine Gaststätten. Eine Abhebung an einem Bankautomaten liegt dabei meist näher am Referenzkurs als ein Schalter in der Prager Altstadt.',
      },
      {
        q: 'Warum werben Prager Wechselstuben mit null Prozent Provision?',
        a: 'Weil sie ihre Vergütung in den Kurs legen statt in eine Gebühr. Ohne Provisionszeile wirkt das Angebot günstig, während der angesetzte Kurs weit vom Referenzkurs entfernt liegen kann. Entscheidend ist allein die ausgezahlte Summe in Kronen.',
      },
    ],
  },

  'eur-huf': {
    lead:
      'Ein Euro entspricht mehreren hundert Ungarischen Forint, deshalb liefert die Umrechnung von EUR in HUF schnell vier- und fünfstellige Beträge. '
      + 'Das ist normal und kein Eingabefehler: Der Forint hat im Alltag keine Untereinheit mehr.',
    h2: 'Wer Euro in Ungarische Forint umrechnet',
    body: [
      'Ungarn ist für deutsche Reisende ein Ziel mit mehreren Anlässen: Städtereisen nach Budapest, Sommer am Balaton, Thermalbäder — und Zahnbehandlungen in Sopron oder Mosonmagyaróvár, wo sich eine ganze Branche auf Patientinnen und Patienten aus dem deutschsprachigen Raum eingestellt hat. Bei einem Kostenvoranschlag über mehrere hunderttausend Forint entscheidet der Kurs mit darüber, ob sich die Fahrt rechnet.',
      'Die Ziffernzahl ist die eigentliche Stolperstelle. Der Fillér wurde 1999 abgeschafft, Ein- und Zwei-Forint-Stücke verschwanden 2008, seither rundet man bar auf fünf Forint. Ein Kaffee kostet vierstellig, eine Hotelnacht fünfstellig, eine Zahnbehandlung sechsstellig. Eine Null zu viel oder zu wenig ist der mit Abstand häufigste Fehler beim Umrechnen dieses Paares.',
      'Hinzu kommt die Automatenfrage. In der Budapester Innenstadt stehen viele Geräte privater Betreiber, die eine eigene Gebühr nehmen und die Abrechnung in Euro anbieten. Ein Automat einer ungarischen Bank rechnet üblicherweise näher am Referenzkurs ab. Restaurants mit Euro-Preisschild setzen den Kurs ebenfalls selbst — die Rechnung in Forint fällt fast immer niedriger aus.',
    ],
    tips: {
      h3: 'Praxis-Hinweise zu EUR/HUF',
      items: [
        'Zählen Sie bei Forint-Beträgen die Stellen, bevor Sie bestätigen: vierstellig ist ein Kaffee, sechsstellig eine Behandlung.',
        'Barzahlungen werden auf fünf Forint gerundet, weil die kleinsten Münzen 2008 eingezogen wurden.',
        'Die ungarische Autobahnvignette e-matrica wird in Forint abgerechnet und gilt kennzeichenbezogen.',
        'Automaten privater Betreiber in Touristenlagen verlangen eine eigene Gebühr zusätzlich zum Kurs.',
      ],
    },
    faq: [
      {
        q: 'Warum sind ungarische Preise so lang?',
        a: 'Der Forint notiert im dreistelligen Bereich zum Euro und hat seit 1999 keine im Umlauf befindliche Untereinheit mehr. Vier- und fünfstellige Beträge sind deshalb Alltag, obwohl die ISO-4217-Tabelle zwei Nachkommastellen ausweist.',
      },
      {
        q: 'Bekomme ich in Ungarn mit Karte oder mit Bargeld den besseren Kurs?',
        a: 'Meist mit der Karte, sofern Sie die Abrechnung in Forint wählen und die angebotene Umrechnung in Euro ablehnen. Wer Bargeld braucht, fährt an einem Bankautomaten besser als an einem Gerät eines privaten Betreibers.',
      },
    ],
  },

  'eur-dkk': {
    lead:
      'Der Kurs von Euro zu Dänischer Krone bewegt sich kaum: Dänemark hält die Krone seit 1999 im Wechselkursmechanismus ERM II eng am Euro. '
      + 'Was eine Reisekasse wirklich kostet, ist deshalb nicht der Kurs selbst, sondern der Aufschlag, den Bank, Automat oder Wechselstube darauf legen.',
    h2: 'Wer Euro in Dänische Kronen umrechnet',
    body: [
      'An der Grenze fließt der Verkehr in beide Richtungen. Dänische Haushalte fahren nach Flensburg und Harrislee, weil Bier, Spirituosen und Süßwaren dort spürbar weniger kosten als nördlich der Grenze; deutsche Familien fahren nach Norden — Rømø, Fanø, die Nordseeküste, Legoland in Billund, Kopenhagen. Für beide Gruppen ist der Kurs eine Randnotiz, die Marge dagegen nicht.',
      'Die feste Anbindung ist politisch gewollt. Dänemark hat sich im Vertrag von Maastricht eine Ausnahme vom Euro gesichert und 2000 in einer Volksabstimmung gegen die Einführung entschieden. Der Leitkurs im ERM II liegt fest, die formale Bandbreite ist eng bemessen — doch die Nationalbank steuert über ihre Zinssätze so, dass der Kurs sich in der Praxis nur in einem Bruchteil dieser Spanne bewegt. Auf einen günstigeren Zeitpunkt zu warten, bringt bei diesem Paar deshalb nichts.',
      'Bezahlt wird in Dänemark fast ausschließlich mit Karte; das Dankort-System ist überall verbreitet. Wer trotzdem bar zahlt, rechnet auf 50 Øre gerundet ab, seit die 25-Øre-Münze 2008 eingezogen wurde.',
    ],
    tips: {
      h3: 'Praxis-Hinweise zu EUR/DKK',
      items: [
        'Warten hilft bei einem so eng geführten Kurs nicht; vergleichen Sie stattdessen die Aufschläge verschiedener Anbieter.',
        'Barzahlungen werden auf 50 Øre gerundet, weil die 25-Øre-Münze seit 2008 aus dem Verkehr ist.',
        'Dänische Terminals bieten die Abrechnung in Euro an; dieser Aufschlag übersteigt fast immer die Kosten Ihrer eigenen Bank.',
        'Geschäfte an der Grenze nehmen Euro an, doch der Hauskurs eines Ladens ist keine Kopie des Leitkurses.',
      ],
    },
    faq: [
      {
        q: 'Warum führt Dänemark den Euro nicht ein, wenn die Krone ohnehin daran hängt?',
        a: 'Dänemark hat im Vertrag von Maastricht eine Ausnahmeregelung erhalten und 2000 per Volksabstimmung gegen die Einführung gestimmt. Die enge Bindung über den Wechselkursmechanismus ERM II besteht davon unabhängig weiter.',
      },
      {
        q: 'Lohnt es sich, für Dänemark auf einen besseren Kurs zu warten?',
        a: 'Kaum. Die Nationalbank hält den Kurs innerhalb eines sehr schmalen Korridors, sodass die Bewegung über Monate kleiner ausfällt als der Unterschied zwischen zwei Anbietern am selben Tag. Der Vergleich lohnt, das Warten nicht.',
      },
    ],
  },

  'eur-sek': {
    lead:
      'Ein Euro entspricht mehreren Schwedischen Kronen, die Umrechnung von EUR in SEK ergibt daher eine größere Zahl als der Ausgangsbetrag. '
      + 'Gebraucht wird sie in Schweden vor allem beim Kartenzahlen: Bargeld nehmen viele Geschäfte gar nicht mehr an.',
    h2: 'Wer Euro in Schwedische Kronen umrechnet',
    body: [
      'Die Fähren ab Rostock und Travemünde, Wohnmobiltouren durch Småland, Angelurlaub, Nordlichter in Lappland: Schweden ist ein Ziel für längere Reisen, bei denen sich kleine Kursunterschiede über zwei bis drei Wochen aufsummieren. Dazu kommen Berufstätige aus Deutschland in Stockholm und Malmö sowie Bestellungen in schwedischen Onlineshops.',
      'Schweden ist eines der bargeldärmsten Länder Europas. Geschäfte, Busse und Museen dürfen Bargeld ablehnen und tun das auch; bezahlt wird mit Karte oder über das heimische System Swish. Mitgebrachte Euro-Scheine helfen deshalb kaum weiter — entscheidend ist der Kurs, zu dem Ihre kartenausgebende Bank abrechnet, und die Frage, ob Sie die Umrechnung des Terminals annehmen.',
      'Anders als die dänische nimmt die schwedische Krone nicht am Wechselkursmechanismus ERM II teil. Die Riksbank verfolgt ein Inflationsziel, nicht ein Kursziel, und die Krone schwankt gegenüber dem Euro entsprechend deutlich. Ein Blick auf den Verlauf über mehrere Jahre zeigt Unterschiede, die eine Reisekasse spürbar verändern.',
    ],
    tips: {
      h3: 'Praxis-Hinweise zu EUR/SEK',
      items: [
        'Rechnen Sie nicht mit Bargeld: Viele Betriebe in Schweden nehmen ausschließlich Karte oder Swish.',
        'Die 50-Öre-Münze wurde 2010 eingezogen; Barbeträge runden auf ganze Kronen, Kartenzahlungen nicht.',
        'Schwedische Preise enthalten die Mehrwertsteuer moms, der umgerechnete Betrag ist also der Endpreis.',
        'SEK, DKK und NOK kürzen alle mit „kr“ ab — prüfen Sie bei einem Preis im Netz, welches Land gemeint ist.',
      ],
    },
    faq: [
      {
        q: 'Ist die Schwedische Krone dasselbe wie die Dänische oder Norwegische Krone?',
        a: 'Nein. Es sind drei eigenständige Währungen mit ähnlichem Namen und derselben Abkürzung kr: SEK, DKK und NOK. Ihre Kurse zum Euro unterscheiden sich deutlich, weshalb der ISO-Code entscheidet, nicht das Wort Krone.',
      },
      {
        q: 'Brauche ich in Schweden überhaupt noch Bargeld?',
        a: 'Für die meisten Reisen nicht. Karte und Swish decken Verkehr, Läden und Gastronomie ab, und mancherorts wird Bargeld ausdrücklich nicht angenommen. Ein kleiner Notvorrat in Kronen schadet auf dem Land trotzdem nicht.',
      },
    ],
  },

  'eur-thb': {
    lead:
      'Ein Euro entspricht mehreren Dutzend Thailändischen Baht, weshalb die Umrechnung von EUR in THB eine deutlich größere Zahl liefert. '
      + '{{app}} rechnet dieselbe Kombination ohne Verbindung weiter — praktisch dort, wo das Datenroaming aufhört.',
    h2: 'Wer Euro in Thailändische Baht umrechnet',
    body: [
      'Thailand gehört seit Jahrzehnten zu den festen Fernzielen deutscher Winterreisender: Phuket, Krabi, Koh Samui, Chiang Mai. Dazu kommt eine zweite, ganz andere Gruppe — Ruheständler, die ihre deutsche Rente in Hua Hin oder Pattaya ausgeben und deshalb nicht einmal im Jahr, sondern jeden Monat auf dieses Paar schauen.',
      'Beim Abheben kostet Thailand systematisch mehr als andere Reiseziele. Thailändische Banken berechnen für Abhebungen mit einer ausländischen Karte eine feste Gebühr je Vorgang, bei den meisten Instituten 220 Baht, unabhängig vom abgehobenen Betrag. Vier kleine Abhebungen kosten also das Vierfache einer großen. Zusätzlich fragt jeder Automat, ob er in Euro abrechnen darf — diese Umrechnung ist eine zweite Gebühr in anderer Verpackung.',
      'Für längere Aufenthalte werden aus dem Kurs harte Grenzwerte. Die thailändischen Behörden verlangen für die Verlängerung eines Ruhestandsaufenthalts entweder 800.000 Baht auf einem thailändischen Konto oder ein monatliches Einkommen von 65.000 Baht. Beide Schwellen stehen in Baht fest; was sich verschiebt, ist der Euro-Betrag dahinter.',
    ],
    tips: {
      h3: 'Praxis-Hinweise zu EUR/THB',
      items: [
        'Wenige große Abhebungen sind günstiger als viele kleine: Die Automatengebühr fällt je Vorgang an, nicht je abgehobenem Baht.',
        'Am Automaten „ohne Umrechnung“ wählen, damit die Belastung in Baht erfolgt und nicht zum Kurs des Geräts.',
        'Wechselstuben in der Stadt rechnen üblicherweise enger am Referenzkurs ab als die Schalter direkt hinter der Passkontrolle.',
        'Der Baht hat 100 Satang, im Alltag werden aber praktisch nur ganze Baht abgerechnet.',
      ],
    },
    faq: [
      {
        q: 'Euro-Bargeld mitnehmen oder in Thailand abheben?',
        a: 'Eine Mischung. Saubere Euro-Scheine lassen sich in Wechselstuben zu Kursen nahe am Referenzkurs tauschen, während jede Kartenabhebung eine feste Automatengebühr kostet. Ein kleiner Baht-Vorrat für die Ankunft erspart den teuren Schalter im Terminal.',
      },
      {
        q: 'Warum schwankt der Baht weniger als andere Fernreise-Währungen?',
        a: 'Die Bank of Thailand hält große Währungsreserven und tritt am Devisenmarkt regelmäßig auf. Der Baht bewegt sich dadurch ruhiger als frei gehandelte Schwellenländerwährungen, ohne an einen festen Leitkurs gebunden zu sein.',
      },
    ],
  },

  'usd-eur': {
    lead:
      'Ein US-Dollar ist weniger wert als ein Euro, eine Umrechnung von USD in EUR ergibt deshalb eine kleinere Zahl als den Ausgangsbetrag. '
      + 'Diese Richtung braucht in Deutschland vor allem, wer Einnahmen in Dollar hat — und die entstehen selten am selben Tag, an dem sie ankommen.',
    h2: 'Wer US-Dollar in Euro umrechnet',
    body: [
      'Die Gruppe ist größer, als sie wirkt: IT-Dienstleister und Freiberufler mit amerikanischen Auftraggebern, Entwicklerinnen mit Auszahlungen aus den App-Stores, Verkäufer auf internationalen Marktplätzen, Autoren mit Tantiemen. Ihre Rechnung lautet auf Dollar, ihr Konto auf Euro, und zwischen Rechnungsdatum und Zahlungseingang liegen oft Wochen. Damit wird aus einem Festpreis unbemerkt eine Währungsposition.',
      'Das deutsche Steuerrecht hat dafür eigene Regeln. Für Zwecke der Umsatzsteuer veröffentlicht das Bundesministerium der Finanzen monatlich Durchschnittskurse, mit denen Fremdwährungsbeträge umgerechnet werden dürfen. Der Tageskurs, den Sie zufällig im Netz finden, ist also nicht automatisch der maßgebliche — was viele erst beim ersten Jahresabschluss mit Dollar-Einnahmen bemerken.',
      'Bleibt der Weg des Geldes. Zahlungsdienstleister rechnen Dollar-Eingänge häufig automatisch in Euro um und legen dabei eine Marge auf den Referenzkurs, die nirgends „Gebühr“ heißt. Ein Fremdwährungskonto verschiebt diesen Schritt auf einen Zeitpunkt, den Sie selbst wählen.',
    ],
    tips: {
      h3: 'Praxis-Hinweise zu USD/EUR',
      items: [
        'Prüfen Sie in den Einstellungen Ihres Zahlungsdienstleisters, ob Dollar-Eingänge automatisch umgerechnet werden.',
        'Für die Umsatzsteuer gelten die monatlichen Durchschnittskurse des Bundesfinanzministeriums, nicht der Kurs des Zahltags.',
        'Dividenden amerikanischer Aktien fließen in Dollar; die Depotbank rechnet sie zu ihrem eigenen Kurs um.',
        'Ein Fremdwährungskonto trennt den Zahlungseingang vom Umtausch und gibt Ihnen den Zeitpunkt zurück.',
      ],
    },
    faq: [
      {
        q: 'Soll ich einen amerikanischen Kunden in Euro oder in Dollar abrechnen?',
        a: 'Eine Rechnung in Euro verlagert das Kursrisiko auf den Kunden, eine Rechnung in Dollar behalten Sie es selbst. Bei Dollar-Rechnungen hängt der Euro-Erlös am Kurs des Zahlungseingangs, nicht am Kurs der Vertragsunterschrift.',
      },
      {
        q: 'Ist USD/EUR einfach der Kehrwert von EUR/USD?',
        a: 'Rechnerisch ja, praktisch nicht ganz. Am Markt gibt es Geld- und Briefkurs, und jeder Anbieter legt seine Marge auf die Richtung, in die Sie tatsächlich tauschen. Der Referenzkurs in {{app}} ist ein Mittelkurs ohne Aufschlag.',
      },
    ],
  },
},

  it: {
  'eur-chf': {
    lead:
      'Per convertire euro (EUR) in franchi svizzeri (CHF) si moltiplica l’importo in euro per il tasso EUR/CHF del momento, che si sposta ogni giorno di mercato. '
      + 'Il conto lo fa {{app}}, gratis e anche in galleria del Gottardo senza campo; per un frontaliere il problema vero non è il tasso, ma dove e quando trasformare lo stipendio.',
    h2: 'Chi in Italia converte euro in franchi svizzeri',
    body: [
      'Il franco è, per l’Italia, prima di tutto una valuta da busta paga. Più di 80.000 lavoratori frontalieri partono ogni mattina dalle province di Varese, Como, Sondrio e dal Verbano verso Ticino, Grigioni e Vallese: incassano in franchi e vivono in euro, quindi EUR/CHF non è per loro una curiosità di mercato ma un conto che si ripete dodici volte l’anno.',
      'La domanda utile non è quanto valga il franco stamattina, ma dove e quando trasformarlo. Un bonifico dal conto svizzero a quello italiano viene accreditato in euro al cambio deciso dalla banca che riceve, e lo scarto rispetto al valore interbancario pesa quasi sempre più della commissione scritta nel foglio informativo. Chi porta invece contanti oltre confine paga il margine dell’ufficio cambi, che nelle località di frontiera varia parecchio da una vetrina all’altra.',
      'C’è poi la parte fiscale, che sorprende chi comincia a lavorare oltre confine: i redditi percepiti in franchi si riportano in euro nella dichiarazione italiana usando i cambi medi mensili pubblicati dall’Agenzia delle Entrate, non la quotazione del giorno in cui lo stipendio è arrivato sul conto. E da gennaio 2015, quando la Banca nazionale svizzera ha abbandonato il cambio minimo con l’euro, la coppia può muoversi in modo brusco nel giro di poche ore.',
    ],
    tips: {
      h3: 'Note pratiche su EUR/CHF',
      items: [
        'Lo stipendio arriva in franchi e le spese restano in euro: scegliere una data fissa del mese per convertire evita di inseguire le notizie.',
        'In Svizzera i pagamenti in contanti si arrotondano a 5 centesimi, perché la monetina da 1 centesimo non circola più.',
        'Molti negozi del Mendrisiotto accettano euro, ma applicano un corso di cambio deciso alla cassa e restituiscono il resto in franchi.',
        'La sigla del franco è CHF e non Fr. sui documenti bancari: nei bonifici conta il codice, non il simbolo stampato sullo scontrino.',
        'In {{app}} conviene fissare EUR/CHF fra i preferiti, così compare per primo a ogni apertura.',
      ],
    },
    faq: [
      {
        q: 'Con quale cambio dichiaro in Italia uno stipendio incassato in franchi?',
        a: 'Per i redditi prodotti all’estero si usano i cambi medi mensili pubblicati dall’Agenzia delle Entrate, riferiti al mese in cui il reddito è stato percepito, non al giorno dell’accredito. Il tasso di riferimento che leggi in {{app}} serve a farsi un’idea dell’ordine di grandezza, non a compilare il quadro della dichiarazione.',
      },
      {
        q: 'Conviene cambiare i franchi in Svizzera o farsi accreditare euro in Italia?',
        a: 'Dipende dal margine applicato, non dal lato del confine. Sia la banca svizzera sia quella italiana aggiungono uno scarto al tasso interbancario, a cui si somma il costo del bonifico. Confronta l’importo davvero accreditato in euro con il tasso di riferimento interbancario dello stesso giorno: la differenza è il costo reale dell’operazione.',
      },
    ],
  },

  'eur-usd': {
    lead:
      'Un euro vale più di un dollaro statunitense, quindi la conversione EUR→USD restituisce una cifra più alta di quella di partenza. '
      + 'Il calcolo lo esegue {{app}}, anche davanti alla vetrina di un outlet americano senza rete; quanto paghi davvero, però, dipende da imposte e dogana più che dal cambio.',
    h2: 'Chi in Italia converte euro in dollari statunitensi',
    body: [
      'Questa coppia interessa due tipi di persone molto diverse. La prima parte per gli Stati Uniti e vuole capire quanto vale il budget delle vacanze una volta atterrata: il problema non è il tasso, è che il cartellino americano è quasi sempre al netto della sales tax, che cambia da uno stato all’altro e compare solo alla cassa, e che al ristorante si aggiunge una mancia intorno al venti per cento.',
      'La seconda compra online su siti americani. Dal 1° luglio 2021 l’esenzione IVA sotto i 22 euro non esiste più: qualunque pacco extra-UE sconta l’IVA all’importazione, i dazi si aggiungono sopra i 150 euro di valore della merce e il corriere addebita le proprie spese di sdoganamento. Il totale in euro pagato davvero è quindi molto più alto della semplice conversione del prezzo esposto.',
      'C’è infine chi fattura in dollari a clienti americani. Il prezzo si concorda oggi e si incassa fra settimane: il cambio che conta è quello del giorno dell’accredito, non quello della firma, e un preventivo a prezzo fisso diventa senza volerlo una posizione in valuta.',
    ],
    tips: {
      h3: 'Note pratiche su EUR/USD',
      items: [
        'Il prezzo esposto negli Stati Uniti raramente comprende le imposte locali sui consumi: converti il totale finale, non il cartellino.',
        'Se il terminale americano propone di addebitarti in euro, rifiuta e paga in dollari: quella conversione la decide l’esercente.',
        'Su un ordine dagli Stati Uniti calcola IVA all’importazione, eventuali dazi sopra i 150 euro e la pratica del corriere.',
        'La coppia reagisce agli annunci della Banca centrale europea e della Federal Reserve, che escono a calendario noto.',
        'Il dollaro ha due decimali come l’euro, quindi nella conversione non si perde nulla negli arrotondamenti.',
      ],
    },
    faq: [
      {
        q: 'Da quale importo si pagano dazi e IVA su un ordine dagli Stati Uniti?',
        a: 'L’IVA all’importazione è dovuta su qualsiasi valore, perché la vecchia franchigia sotto i 22 euro è stata abolita nel luglio 2021. I dazi doganali scattano invece sopra i 150 euro di valore della merce, spedizione esclusa, e vanno sommati alle spese di gestione del corriere.',
      },
      {
        q: 'Perché alla cassa negli Stati Uniti pago più del prezzo scritto sull’etichetta?',
        a: 'Perché l’imposta sulle vendite viene aggiunta al momento del pagamento e varia da stato a stato, in alcuni casi anche da contea a contea. Converti quindi lo scontrino finale, non il numero stampato sullo scaffale.',
      },
    ],
  },

  'eur-ron': {
    lead:
      'Il leu rumeno (RON) vale una piccola frazione di euro, quindi la conversione EUR→RON restituisce un numero parecchio più lungo di quello di partenza. '
      + 'A farla è {{app}}, sul telefono e anche senza connessione; su un invio mensile ripetuto pesa però molto di più il margine applicato all’accredito.',
    h2: 'Chi in Italia converte euro in lei rumeni',
    body: [
      'I cittadini romeni sono la comunità straniera più numerosa in Italia, oltre un milione di persone, e questa coppia entra nella vita quotidiana di famiglie divise fra due paesi: uno stipendio incassato in euro, un mutuo o una pensione dei genitori da coprire in lei, una casa ristrutturata in Oltenia o in Moldova rumena con i soldi guadagnati in Veneto.',
      'La Romania è nell’Unione europea e nell’area SEPA, quindi un bonifico in euro verso un IBAN rumeno costa quanto un bonifico interno: la parte cara non è il trasferimento, è la conversione. Se il conto di destinazione è in lei, il cambio lo sceglie la banca che accredita, e su invii mensili ripetuti quello scarto vale più di qualsiasi commissione.',
      'C’è anche una questione di riferimento condiviso. La Banca Nazionale della Romania pubblica ogni giorno lavorativo un cambio ufficiale che in Romania regola contratti, bollette e pratiche amministrative: quando parenti e uffici citano un numero, quasi sempre citano quello. E chi ricorda i prezzi prima della riforma del 2005 continua a ragionare in milioni, perché un leu di oggi ne vale diecimila vecchi.',
    ],
    tips: {
      h3: 'Note pratiche su EUR/RON',
      items: [
        'Un leu si divide in 100 bani; al plurale si dice lei, e il codice ISO 4217 resta RON.',
        'Un bonifico SEPA in euro verso la Romania ha lo stesso costo di uno nazionale: quello che cambia è il tasso applicato all’accredito in lei.',
        'La Banca Nazionale della Romania diffonde un cambio ufficiale giornaliero: è il numero a cui si riferiscono uffici e contratti.',
        'In Romania le case di cambio di città praticano condizioni migliori rispetto ai banchi degli aeroporti.',
        'Se ricevi un prezzo espresso in milioni, chi parla sta ragionando in lei vecchi, quelli precedenti alla riforma del 2005.',
      ],
    },
    faq: [
      {
        q: 'Conviene mandare euro o lei alla famiglia in Romania?',
        a: 'Mandare euro su un conto in euro lascia a chi riceve la scelta del momento e dello sportello; mandare denaro che viene accreditato direttamente in lei affida la conversione alla banca ricevente. La differenza si misura confrontando i lei realmente disponibili con il tasso di riferimento interbancario che {{app}} mostra nello stesso momento.',
      },
      {
        q: 'Perché il cambio della mia banca non coincide con quello della banca centrale rumena?',
        a: 'Perché il cambio ufficiale giornaliero è un riferimento amministrativo, non un prezzo a cui si compra. Ogni operatore parte da lì e aggiunge il proprio margine, diverso fra sportello, home banking e casa di cambio.',
      },
    ],
  },

  'eur-gbp': {
    lead:
      'Una sterlina britannica (GBP) vale più di un euro, quindi la conversione EUR→GBP restituisce un numero più piccolo dell’importo iniziale. '
      + 'La cifra esatta la dà {{app}}, gratis su Android e iOS; dopo la Brexit, però, fra il prezzo esposto su un sito britannico e quello che paghi si è messa la dogana.',
    h2: 'Chi in Italia converte euro in sterline britanniche',
    body: [
      'Il Regno Unito resta una delle mete principali degli italiani che lavorano o studiano all’estero, e Londra ospita una delle comunità italiane più numerose fuori dall’Italia. Per chi ci vive la coppia è un affitto in sterline pagato con risparmi in euro, o al contrario uno stipendio in sterline da spedire a casa.',
      'Dal 1° gennaio 2021 il Regno Unito è fuori dal mercato unico, e questo ha cambiato soprattutto gli acquisti online. Un ordine su un sito britannico è a tutti gli effetti un’importazione: al prezzo convertito si aggiungono IVA italiana e, sopra i 150 euro di merce, i dazi. Il prezzo mostrato sul sito comprende però la VAT britannica al 20%, che i venditori attrezzati scorporano in fase di pagamento per l’estero: senza quello scorporo l’imposta la paghi due volte.',
      'Sul posto la differenza culturale è il contante, quasi scomparso: pub, autobus e musei funzionano con carta contactless. È lì che si incontra la proposta di addebito in euro sul terminale, che sposta la conversione dall’emittente della carta al negoziante.',
    ],
    tips: {
      h3: 'Note pratiche su EUR/GBP',
      items: [
        'Nel Regno Unito il prezzo esposto comprende già la VAT, al contrario delle etichette statunitensi.',
        'Sui terminali londinesi scegli sempre l’addebito in sterline: l’opzione in euro nasconde un margine dell’esercente.',
        'Banconote scozzesi e nordirlandesi sono la stessa sterlina allo stesso cambio, anche se fuori dalla Scozia sono meno note.',
        'Verifica se il sito britannico scorpora la propria imposta per le spedizioni verso l’Italia, altrimenti pagherai due volte l’IVA.',
        'Una sterlina si divide in 100 penny: nel parlato la cifra intera diventa spesso quid.',
      ],
    },
    faq: [
      {
        q: 'Il prezzo indicato su un sito britannico è quello che pagherò davvero?',
        a: 'Quasi mai. Dopo la Brexit il pacco entra in Italia come importazione, quindi si aggiungono IVA e, oltre i 150 euro di merce, dazi e pratica del corriere. Alcuni negozi tolgono in cambio la propria imposta interna al momento del pagamento.',
      },
      {
        q: 'Perché in aeroporto il cambio euro-sterlina sembra molto peggiore che in città?',
        a: 'Perché nei banchi aeroportuali il margine sul tasso di riferimento è più ampio e le commissioni fisse pesano soprattutto sulle somme piccole. Prelevare sterline da uno sportello bancario o pagare direttamente con la carta resta di norma più vicino al valore interbancario.',
      },
    ],
  },

  'eur-uah': {
    lead:
      'Un euro vale molte grivnie ucraine (UAH), perciò la conversione EUR→UAH restituisce numeri con parecchie cifre in più. '
      + 'La conversione la fa {{app}}, che conserva l’ultimo valore scaricato quando la rete non c’è; da che cosa dipenda quel valore è la parte davvero utile da sapere.',
    h2: 'Chi in Italia converte euro in grivnie ucraine',
    body: [
      'La presenza ucraina in Italia è una delle più radicate d’Europa: prima del 2022 contava già oltre duecentomila persone, in larga parte donne impiegate nell’assistenza familiare fra Campania, Lombardia ed Emilia-Romagna, e dal 2022 si è aggiunto chi è arrivato con la protezione temporanea. Il denaro che parte da qui verso Leopoli, Kiev o Vinnycja segue un ritmo mensile, non speculativo.',
      'La grivnia ha una storia recente particolare. Dal febbraio 2022 la Banca nazionale d’Ucraina l’ha tenuta fissa rispetto al dollaro statunitense; il 3 ottobre 2023 è passata a una flessibilità gestita, quindi la moneta oggi si muove dentro un binario sorvegliato dalla banca centrale. Poiché quella gestione guarda al dollaro, il valore in euro cambia soprattutto quando cambia EUR/USD: capita così che il cambio euro-grivnia si sposti in una giornata in cui in Ucraina non è successo nulla di monetario.',
      'Restano poi i controlli valutari introdotti con la legge marziale, che limitano acquisto e trasferimento di valuta estera e rendono i canali ufficiali meno flessibili del solito.',
    ],
    tips: {
      h3: 'Note pratiche su EUR/UAH',
      items: [
        'Il valore in euro della grivnia dipende in larga parte dal cambio euro-dollaro, perché la banca centrale ucraina guarda al dollaro.',
        'I chioschi di cambio rifiutano banconote strappate, scritte o macchiate: porta biglietti integri e di taglio grande.',
        'Le monetine da 1, 2 e 5 copechi sono state ritirate: sul contante i totali vengono arrotondati.',
        'Il simbolo della grivnia è ₴ e il codice è UAH; nei bonifici conta solo il codice.',
        'Salva il cambio in {{app}} prima di partire: nelle zone con corrente e rete intermittenti il valore memorizzato resta consultabile.',
      ],
    },
    faq: [
      {
        q: 'Perché il cambio euro-grivnia si muove anche quando in Ucraina non cambia nulla?',
        a: 'Perché la grivnia è gestita rispetto al dollaro statunitense. Il valore in euro nasce dall’incrocio fra quel rapporto e il cambio euro-dollaro, quindi una notizia sulla politica monetaria americana o europea basta a spostarlo.',
      },
      {
        q: 'Conviene portare euro in contanti in Ucraina?',
        a: 'Gli euro sono cambiati senza difficoltà negli sportelli autorizzati, ma le condizioni peggiorano sensibilmente per banconote rovinate o di piccolo taglio. Conserva la ricevuta del cambio e confronta la cifra ricevuta con il tasso di riferimento interbancario dello stesso giorno.',
      },
    ],
  },

  'eur-mad': {
    lead:
      'Convertire euro (EUR) in dirham marocchini (MAD) restituisce un numero molto più grande, ma il dirham resta una valuta non convertibile fuori dal Marocco. '
      + 'Sapere che cifra aspettarsi allo sportello è compito di {{app}}, consultabile anche senza rete; il resto lo decidono regole valutarie che conviene conoscere prima di partire.',
    h2: 'Chi in Italia converte euro in dirham marocchini',
    body: [
      'La comunità marocchina in Italia supera le quattrocentomila persone ed è fra le più antiche: molte famiglie sono qui da due o tre generazioni, con un piede in Lombardia, Piemonte o Emilia e uno fra Casablanca, Beni Mellal e il Rif. Le rimesse verso il Marocco sono una voce importante del bilancio familiare e si concentrano d’estate e nei periodi di festa, quando si torna con l’auto o con il traghetto.',
      'La particolarità monetaria è che il dirham non si compra in Italia: non è quotato sui mercati internazionali e le banconote non possono uscire dal paese se non entro una piccola franchigia. Il cambio si fa all’arrivo, in banca, in aeroporto o negli uffici autorizzati, e conservare la ricevuta permette di riconvertire i dirham avanzati prima di ripartire.',
      'Bank Al-Maghrib non lascia fluttuare liberamente la moneta: la ancora a un paniere composto per il 60% da euro e per il 40% da dollari, dentro una banda di oscillazione portata a ±2,5% nel gennaio 2018 e a ±5% nel marzo 2020. Il risultato è che il cambio euro-dirham si muove poco, e la vera variabile del viaggio è il margine applicato dallo sportello.',
    ],
    tips: {
      h3: 'Note pratiche su EUR/MAD',
      items: [
        'I dirham non si trovano nelle agenzie di cambio italiane: il denaro si converte una volta arrivati in Marocco.',
        'Tieni le ricevute del cambio: servono per riconvertire in euro quello che avanza prima del volo di rientro.',
        'Nei souk i prezzi si dicono spesso in rial, che valgono un ventesimo di dirham, oppure in centimes, che ne valgono un centesimo: chiediti sempre in quale unità ti stanno parlando.',
        'Poiché la moneta è ancorata a un paniere per la maggior parte in euro, il grafico è piatto: a fare la differenza è la commissione, non il mercato.',
        'D’estate le file agli sportelli si allungano ma le condizioni non migliorano: confrontare prima con il valore di riferimento resta l’unico modo per capire quanto costa il cambio.',
      ],
    },
    faq: [
      {
        q: 'Posso comprare dirham in Italia prima di partire per il Marocco?',
        a: 'Di norma no. Il dirham è una valuta non convertibile all’estero e non viene trattato fuori dal Marocco, quindi il cambio si effettua sul posto presso banche, aeroporti e uffici autorizzati. Portare euro in contanti o prelevare all’arrivo sono le due strade abituali.',
      },
      {
        q: 'Perché il cambio euro-dirham cambia così poco nel tempo?',
        a: 'Perché la banca centrale marocchina aggancia il dirham a un paniere formato per il 60% da euro e per il 40% da dollari, dentro una banda di oscillazione. Il tasso resta quindi molto stabile, mentre i margini applicati dai singoli sportelli variano parecchio.',
      },
    ],
  },

  'eur-egp': {
    lead:
      'La sterlina egiziana (EGP) usa un simbolo simile a quello britannico ma è tutt’altra moneta: la conversione EUR→EGP restituisce numeri lunghi. '
      + 'A tenere separati i due codici e a fare il conto ci pensa {{app}}, anche senza rete; resta da capire perché quel numero sia cambiato tanto in pochi anni.',
    h2: 'Chi in Italia converte euro in sterline egiziane',
    body: [
      'Milano ospita una delle comunità egiziane più grandi d’Europa e in Italia i cittadini egiziani superano abbondantemente le centomila unità, concentrati fra Lombardia e Lazio. L’Egitto è del resto fra i primi paesi al mondo per rimesse ricevute, e il denaro che arriva dall’estero è una delle poche fonti stabili di valuta forte per le famiglie.',
      'Il cambio con la sterlina egiziana è stato il tema economico del paese negli ultimi anni. Fino al marzo 2024 convivevano un tasso ufficiale e un mercato parallelo molto più caro, e chi mandava soldi doveva scegliere fra un canale legale svantaggioso e uno informale rischioso. Con la svolta del 2024 la banca centrale ha lasciato che la moneta trovasse un livello di mercato e quella forbice si è richiusa, restituendo senso ai canali bancari.',
      'Poi c’è il Mar Rosso: Sharm el-Sheikh, Marsa Alam e Hurghada sono da decenni pacchetti da catalogo per gli italiani. Nei villaggi i listini sono spesso esposti in euro, ma la conversione la decide l’albergo, non il mercato.',
    ],
    tips: {
      h3: 'Note pratiche su EUR/EGP',
      items: [
        'Un simbolo di sterlina da solo non basta a capire di quale moneta si parli: controlla il codice EGP prima di convertire.',
        'Nei resort il listino in euro nasconde il cambio scelto dalla struttura: pagare in sterline egiziane di solito rende di più.',
        'Da quando il tasso ufficiale ha raggiunto il livello di mercato, un cambio “speciale” offerto per strada ha perso la sua ragione d’essere.',
        'Le piastre non circolano più nell’uso quotidiano: gli importi si leggono come numeri interi.',
        'Sulle rimesse confronta la cifra in sterline egiziane effettivamente accreditata, non la commissione dichiarata in vetrina.',
      ],
    },
    faq: [
      {
        q: 'Perché il valore della sterlina egiziana è cambiato tanto negli ultimi anni?',
        a: 'Perché l’Egitto ha attraversato una serie di svalutazioni e, nel marzo 2024, ha lasciato che la moneta si allineasse al livello di mercato nell’ambito di un programma di sostegno internazionale. Il mercato parallelo, che prima offriva molto più del tasso ufficiale, si è così sgonfiato.',
      },
      {
        q: 'In un villaggio sul Mar Rosso conviene pagare in euro o in sterline egiziane?',
        a: 'Quasi sempre in valuta locale. Quando la struttura accetta euro applica un proprio tasso di conversione, arrotondato a proprio favore, mentre pagando in sterline egiziane la conversione la fa l’emittente della carta a condizioni più vicine al riferimento interbancario.',
      },
    ],
  },

  'eur-php': {
    lead:
      'Convertire euro (EUR) in pesos filippini (PHP) restituisce una cifra molto più grande, ed è il conto che accompagna ogni rimessa mensile verso le Filippine. '
      + 'Il conto lo fa {{app}}, gratis e anche senza connessione; quanti pesos arrivino davvero a destinazione lo decide però il canale scelto per l’invio.',
    h2: 'Chi in Italia converte euro in pesos filippini',
    body: [
      'La comunità filippina in Italia sfiora le centosessantamila persone e vive soprattutto a Milano, Roma, Firenze e Bologna, con una forte presenza nel lavoro domestico e di cura. È una delle diaspore più organizzate attorno all’invio di denaro: la padala verso Luzon o le Visayas parte a data fissa, agganciata al giorno di paga più che all’umore dei mercati.',
      'Il ritmo annuale è altrettanto riconoscibile. Fra novembre e dicembre gli invii aumentano per il Natale e per la tredicesima, e le agenzie riempiono le vetrine di promozioni: in quelle settimane la differenza fra un operatore e l’altro non sta nel tasso interbancario, che è uguale per tutti, ma nel margine che ciascuno ci somma sopra.',
      'L’altra scelta è il canale. Ritiro in contanti allo sportello di un partner nelle province, accredito su conto bancario o versamento su portafoglio elettronico non hanno lo stesso costo, e lo stesso operatore può applicare condizioni diverse a seconda del canale scelto. Guardare quanti pesos arrivano davvero, e non la commissione dichiarata, è l’unico confronto che conta.',
    ],
    tips: {
      h3: 'Note pratiche su EUR/PHP',
      items: [
        'Il peso filippino si scrive ₱ e ha codice PHP: non va confuso con i pesos messicano, colombiano o argentino, che usano il segno del dollaro.',
        'Nel fine settimana il mercato interbancario è chiuso e gli operatori quotano su un riferimento fermo, di solito con margine più largo.',
        'Ritiro in contanti, bonifico e portafoglio elettronico hanno costi diversi anche presso la stessa agenzia.',
        'Confronta i pesos accreditati a destinazione, non l’importo della commissione esposta al banco.',
        'Nelle province la copertura è discontinua: la conversione senza rete di {{app}} torna utile a chi riceve.',
      ],
    },
    faq: [
      {
        q: 'A dicembre conviene aspettare un momento migliore per inviare denaro nelle Filippine?',
        a: 'Il tasso interbancario non segue il calendario delle feste. Quello che cambia a dicembre è il volume delle rimesse e l’aggressività delle promozioni: la differenza reale si misura confrontando i pesos consegnati da due operatori nello stesso giorno.',
      },
      {
        q: 'Il simbolo ₱ è lo stesso del peso messicano?',
        a: 'No. Il peso filippino ha un simbolo proprio, ₱, mentre messicano, colombiano e argentino usano il segno del dollaro. I codici ISO 4217 li distinguono senza ambiguità: PHP, MXN, COP e ARS indicano monete di valore molto diverso.',
      },
    ],
  },

  'eur-try': {
    lead:
      'La lira turca (TRY) ha perso valore per anni, quindi la conversione EUR→TRY restituisce cifre alte e un preventivo di qualche mese fa non vale più oggi. '
      + '{{app}} aggiorna il cambio più volte nell’arco della giornata e lo tiene in memoria anche senza rete; ecco perché in Turchia i listini per gli stranieri sono quasi sempre in euro.',
    h2: 'Chi in Italia converte euro in lire turche',
    body: [
      'Istanbul, la costa di Antalya e la Cappadocia sono da anni fra le mete più vendute dalle agenzie italiane, e accanto al turismo classico è cresciuto quello sanitario: cliniche dentali e centri per il trapianto di capelli si rivolgono direttamente al pubblico italiano. Quasi tutte quelle strutture espongono i preventivi in euro, e non per gentilezza: è il modo di proteggersi da una moneta che ha perso potere d’acquisto anno dopo anno.',
      'Per chi viaggia la conseguenza pratica è che il prezzo va riconvertito quando si paga, non quando si prenota. Nei bazar la trattativa si apre spesso in euro a un cambio deciso dal venditore, sistematicamente peggiore di quello che si otterrebbe pagando in lire con la carta.',
      'C’è infine un dettaglio storico che continua a comparire nelle conversazioni: nel 2005 la Turchia ha tolto sei zeri alla vecchia lira, e chi ha una certa età parla ancora in milioni per indicare cifre che oggi si scrivono con poche cifre. Il simbolo ₺, introdotto nel 2012, convive ancora con la vecchia sigla TL sui cartellini.',
    ],
    tips: {
      h3: 'Note pratiche su EUR/TRY',
      items: [
        'Paga in lire con la carta: il prezzo “in euro” proposto dal negoziante incorpora già un cambio scelto da lui.',
        'Gli sportelli automatici turchi applicano una commissione fissa per prelievo alle carte estere, quindi pochi prelievi grandi costano meno di tanti piccoli.',
        'Un preventivo in euro di una clinica non è un cambio: è un prezzo, e resta tale anche se la lira si muove.',
        'Le lire avanzate si ricambiano male in Italia: meglio spenderle o riconvertirle prima di partire.',
        'Una lira si divide in 100 kuruş, e i prezzi antecedenti alla riforma del 2005 vengono ancora citati in milioni.',
      ],
    },
    faq: [
      {
        q: 'Conviene cambiare euro in lire turche prima di partire dall’Italia?',
        a: 'Di regola no: gli uffici cambio italiani trattano la lira a condizioni poco vantaggiose. Prelevare all’arrivo o pagare direttamente in lire con la carta avvicina molto di più al tasso di riferimento, tenendo conto delle commissioni fisse di prelievo.',
      },
      {
        q: 'Perché in Turchia certi prezzi vengono ancora detti in milioni?',
        a: 'Perché nel 2005 sono stati tolti sei zeri alla valuta e una parte della popolazione continua a usare le vecchie grandezze nel parlato. È una convenzione linguistica, non una moneta diversa: il codice resta TRY.',
      },
    ],
  },

  'eur-tnd': {
    lead:
      'Il dinaro tunisino (TND) ha tre decimali — mille millimes per dinaro — quindi la conversione EUR→TND restituisce una cifra decimale in più del solito. '
      + 'Quel formato {{app}} lo rispetta sul telefono; il vincolo da conoscere prima di imbarcarsi, però, è un altro e riguarda le banconote.',
    h2: 'Chi in Italia converte euro in dinari tunisini',
    body: [
      'La Tunisia è la sponda africana più vicina alla Sicilia e la comunità tunisina in Italia, attorno al centinaio di migliaia di persone, ha il suo cuore storico a Mazara del Vallo, dove la pesca ha legato le due sponde per decenni. D’estate le partenze da Palermo, Genova e Civitavecchia riempiono le navi di famiglie che rientrano con l’auto carica, e il denaro che accompagna quei viaggi è quasi sempre contante in euro.',
      'Il punto da conoscere prima di partire è che il dinaro non è esportabile: non lo si compra in Italia e non lo si può portare fuori dalla Tunisia. Si cambia all’arrivo e si riconverte alla partenza entro limiti precisi, esibendo le ricevute delle operazioni fatte. Il cambio non nasce da una quotazione internazionale libera ma dal listino pubblicato dalla Banca Centrale di Tunisia.',
      'Il terzo decimale, infine, è la trappola tipografica: un cartellino che indica un prezzo con tre cifre dopo la virgola non è un errore, sono i millimes. Chi legge all’italiana confonde facilmente le centinaia di millimes con i centesimi e sbaglia l’ordine di grandezza della spesa.',
    ],
    tips: {
      h3: 'Note pratiche su EUR/TND',
      items: [
        'Il dinaro ha tre decimali: un prezzo con tre cifre dopo la virgola indica i millimes, non i centesimi.',
        'Non si acquistano dinari in Italia e non si portano fuori dalla Tunisia: il cambio si fa in loco.',
        'Tieni tutte le ricevute del cambio: senza quelle la riconversione dei dinari avanzati alla partenza diventa difficile.',
        'Chi esce dall’Unione europea con almeno diecimila euro in contanti deve dichiararli in dogana: vale anche per il traghetto.',
        'Nelle zone turistiche l’euro viene accettato in modo informale, ma al cambio deciso dal venditore.',
      ],
    },
    faq: [
      {
        q: 'Posso riportare in Italia i dinari tunisini che mi avanzano?',
        a: 'No, l’uscita di banconote in dinari dal paese non è consentita. I dinari residui vanno riconvertiti prima della partenza presso banche o uffici autorizzati, entro un limite legato all’importo che avevi cambiato e presentando le relative ricevute.',
      },
      {
        q: 'Perché i prezzi in Tunisia hanno tre cifre dopo la virgola?',
        a: 'Perché il dinaro si divide in mille millimes e l’esponente ISO 4217 della valuta è 3, non 2 come per l’euro. Un importo scritto con tre decimali è quindi normale e va letto in dinari e millimes.',
      },
    ],
  },

  'eur-aed': {
    lead:
      'Il dirham degli Emirati (AED) è fissato al dollaro statunitense dal 1997, quindi il cambio euro-dirham si muove solo perché si muove EUR/USD. '
      + 'Del passaggio attraverso il dollaro si occupa {{app}}, anche senza rete; per chi vive o viaggia negli Emirati quello che conta davvero è dove cambiare.',
    h2: 'Chi in Italia converte euro in dirham degli Emirati',
    body: [
      'Dubai e Abu Dhabi sono diventate una destinazione doppia per gli italiani: da un lato il viaggio, spesso con scalo o soggiorno breve, dall’altro il lavoro, con una colonia crescente di professionisti, ristoratori e personale del settore aereo. Chi ci lavora percepisce lo stipendio in dirham e manda euro a casa; chi ci va in vacanza fa il percorso inverso.',
      'La cosa più utile da sapere su questa coppia non è il livello del cambio ma la sua meccanica. Poiché il dirham è agganciato al dollaro da quasi trent’anni, il grafico euro-dirham a cinque anni è, nella pratica, il grafico euro-dollaro ridisegnato. Le notizie che spostano il tuo potere d’acquisto negli Emirati arrivano da Francoforte e da Washington, non da Abu Dhabi.',
      'Ne consegue che il costo di un cambio negli Emirati non dipende quasi per nulla dal mercato: dipende da dove lo fai. Le case di cambio nei quartieri commerciali e nei centri commerciali applicano margini molto più stretti rispetto ai banchi degli alberghi, e sui terminali la proposta di addebito in euro è la scelta più cara di tutte.',
    ],
    tips: {
      h3: 'Note pratiche su EUR/AED',
      items: [
        'Il rapporto fra dirham e dollaro è fisso dal 1997: sul cambio euro-dirham pesa solo il lato euro-dollaro.',
        'Un grafico pluriennale della coppia serve più a capire l’euro rispetto al dollaro che gli Emirati.',
        'Le case di cambio locali trattano l’euro contante a condizioni migliori dei banchi in albergo.',
        'Un dirham si divide in 100 fils, ma le monetine più piccole non circolano e i totali in contanti si arrotondano.',
        'Sui terminali rifiuta l’addebito in euro: il margine lo decide l’esercente, non la tua banca.',
      ],
    },
    faq: [
      {
        q: 'Se il dirham è fisso, perché il valore in euro cambia da un giorno all’altro?',
        a: 'Perché il rapporto fisso riguarda dirham e dollaro statunitense, non dirham ed euro. Il valore in euro è un incrocio: si muove ogni volta che si muove il cambio euro-dollaro, anche se ad Abu Dhabi non è cambiato nulla.',
      },
      {
        q: 'Conviene portare euro in contanti a Dubai o pagare con la carta?',
        a: 'Entrambe le strade funzionano, ma il costo cambia. Le case di cambio locali accettano euro con margini contenuti, mentre pagando con la carta la spesa dipende dalle commissioni sulla valuta estera del tuo emittente e dall’avere rifiutato l’addebito in euro sul terminale.',
      },
    ],
  },

  'usd-eur': {
    lead:
      'Un dollaro statunitense vale meno di un euro, quindi la conversione USD→EUR restituisce sempre una cifra più bassa del numero di partenza. '
      + 'Il calcolo lo fa {{app}} sul telefono, anche senza connessione; qui si guarda invece a chi i dollari li incassa e poi ci deve vivere in euro.',
    h2: 'Chi in Italia converte dollari statunitensi in euro',
    body: [
      'Letta in questo verso, la coppia riguarda soprattutto chi incassa. Sviluppatori e professionisti con clienti americani, autori e creatori pagati dagli store digitali, venditori su marketplace internazionali: tutti ricevono dollari e ragionano in euro. Il numero decisivo non è quello del giorno in cui hai emesso la fattura, ma quello del giorno in cui la banca accredita, e fra i due possono passare settimane.',
      'Il secondo gruppo è il risparmiatore. Gran parte degli strumenti quotati contiene attività denominate in dollari, e la quotazione in euro su Borsa Italiana non elimina il rischio di cambio: il prezzo in euro incorpora già il rapporto fra le due monete, per cui il rendimento finale dipende anche da lì. Solo le classi con copertura valutaria riducono l’effetto, e la copertura ha un costo che erode il risultato.',
      'Infine ci sono i dollari materiali, quelli rimasti in tasca dopo un viaggio. Molte filiali italiane non trattano più valuta estera allo sportello e chi lo fa applica margini larghi, tanto che spesso conviene tenerli per il viaggio successivo invece di riconvertirli.',
    ],
    tips: {
      h3: 'Note pratiche su USD/EUR',
      items: [
        'Su un incasso in dollari il cambio che conta è quello del giorno dell’accredito, non della data della fattura.',
        'Un fondo quotato in euro non è un fondo senza rischio di cambio: guarda la valuta delle attività sottostanti.',
        'Prima di rientrare con banconote americane, verifica se la tua filiale cambia ancora valuta estera allo sportello.',
        'Le banconote statunitensi hanno tutte lo stesso formato e colori simili: controlla la cifra prima di consegnarle.',
        'Dollaro ed euro hanno entrambi due decimali, quindi la conversione non perde nulla negli arrotondamenti.',
      ],
    },
    faq: [
      {
        q: 'Un fondo quotato in euro mi protegge dalle oscillazioni del dollaro?',
        a: 'No. La valuta di quotazione non coincide con la valuta di esposizione: se le attività sottostanti sono in dollari, il risultato in euro dipende anche dal cambio. Solo una classe con copertura valutaria attenua l’effetto, a fronte di un costo aggiuntivo.',
      },
      {
        q: 'Conviene tenere i dollari incassati e convertirli più avanti?',
        a: 'Rimandare la conversione significa mantenere una posizione in valuta, anche senza volerlo. Se quel denaro serve per spese in euro, l’attesa è un rischio; un conto multivaluta permette almeno di scegliere il momento invece di subire il cambio applicato all’accredito.',
      },
    ],
  },
},

  pt: {
  'usd-brl': {
    lead:
      'Converter dólar americano (USD) em real brasileiro (BRL) é multiplicar o valor em dólares pela cotação USD/BRL do momento, que muda ao longo de todo o pregão. '
      + 'Quem faz essa conta é o {{app}}, gratuito no Android e no iOS e útil até sem internet. Esta página cuida do resto: PTAX, dólar turismo, spread e IOF.',
    h2: 'Quem converte dólar americano em real brasileiro',
    body: [
      '“Dólar hoje” é provavelmente a consulta financeira mais repetida no Brasil, e ela aparece em três situações bem diferentes: antes de comprar moeda para viajar, na hora de fechar uma compra em site estrangeiro e no dia em que a fatura internacional do cartão fecha. Em cada uma delas a cotação relevante é outra.',
      'O Banco Central do Brasil apura e divulga a PTAX, média do dia calculada a partir de consultas feitas aos dealers em janelas ao longo do pregão. Ela serve de referência para contratos e para faturas, mas ninguém compra papel-moeda por ela: o balcão trabalha com o chamado dólar turismo, que já embute o spread da casa. A distância entre o dólar comercial e o dólar turismo é o custo verdadeiro da troca, e costuma superar a tarifa anunciada na vitrine.',
      'Some a isso o IOF, que incide sobre operações de câmbio com alíquota variável conforme o tipo de operação — espécie, cartão, transferência — e é fixada por decreto, ou seja, muda por decisão de governo, não pelo mercado. Comparar propostas só faz sentido olhando o valor final em reais, com spread e imposto já dentro.',
    ],
    tips: {
      h3: 'Notas práticas para USD/BRL',
      items: [
        'Dólar comercial e dólar turismo são duas cotações distintas, e a segunda é sempre pior para quem compra espécie.',
        'A compra internacional no cartão é convertida na data em que o emissor processa a transação, não na data da viagem.',
        'O IOF entra por cima da cotação: peça o valor final em reais antes de confirmar a operação.',
        'O par reage às decisões de juros do Copom e do Federal Reserve, ambas com calendário divulgado com antecedência.',
        'Balcões de aeroporto trabalham com margem maior, então deixar a troca para o embarque costuma custar caro.',
      ],
    },
    faq: [
      {
        q: 'Qual é a diferença entre dólar comercial e dólar turismo?',
        a: 'O dólar comercial é a referência usada em contratos, importações e faturas de cartão. O dólar turismo é o preço do papel-moeda no balcão da casa de câmbio, com o spread dela já embutido, e por isso sai mais caro para quem viaja.',
      },
      {
        q: 'Por que minha fatura internacional não bate com a cotação do dia da compra?',
        a: 'Porque o emissor converte a transação na data em que ela é processada, que pode cair dias depois, e aplica o IOF sobre esse resultado. A referência interbancária que o {{app}} exibe é o ponto de partida dessa conta, não o valor final.',
      },
    ],
  },

  'eur-brl': {
    lead:
      'Converter euro (EUR) em real brasileiro (BRL) é multiplicar o valor em euros pela cotação EUR/BRL, que no Brasil é montada a partir do dólar. '
      + 'O cálculo fica com o {{app}}, que segue rodando no Android e no iOS com o último valor salvo quando você está sem sinal. Esta página explica por que o euro no Brasil passa antes pelo dólar.',
    h2: 'Quem converte euro em real brasileiro',
    body: [
      'O euro circula em mais de vinte países da União Europeia, o que faz dele a cotação certa para um roteiro inteiro — Lisboa, Porto, Madri, Paris, Roma — sem trocar de moeda a cada fronteira. Para o público brasileiro, porém, o euro raramente é só turismo: Portugal concentra a maior comunidade brasileira do continente, e o vaivém de mensalidades, aluguéis e envios de dinheiro é constante nos dois sentidos.',
      'Uma boa notícia de formato: Portugal e a maior parte da zona do euro escrevem números como o Brasil, com vírgula separando os centavos e ponto separando os milhares. Um preço marcado como 1.234,56 € se lê exatamente como você espera, sem a inversão que confunde quem vem de vitrine em inglês.',
      'O que muda mesmo é o imposto. O IVA europeu já vem dentro do preço da etiqueta, igual ao Brasil, mas quem mora fora da União Europeia pode pedir devolução do imposto em compras acima de um valor mínimo, com formulário emitido na loja e validado na saída do bloco. Vale converter o valor líquido, depois da devolução, e não o da etiqueta.',
    ],
    tips: {
      h3: 'Notas práticas para EUR/BRL',
      items: [
        'Na maquininha europeia, recuse a oferta de pagar em reais: essa conversão é do lojista e costuma ser a pior da operação.',
        'Euro e real têm duas casas decimais, então nada se perde no arredondamento entre as duas.',
        'A cédula de 500 euros deixou de ser emitida em 2019; as antigas seguem válidas, mas muitos balcões se recusam a aceitá-las.',
        'As mesas brasileiras precificam o euro a partir do dólar, então a cotação que chega ao cliente carrega duas margens.',
      ],
    },
    faq: [
      {
        q: 'Posso usar euro em toda a Europa?',
        a: 'Não em toda. O euro circula em mais de vinte países da União Europeia, mas Reino Unido, Suíça, Polônia, Hungria, República Tcheca e Suécia, entre outros, mantêm moeda própria. Confira país por país antes de decidir quanto levar em espécie.',
      },
      {
        q: 'Compensa comprar euro em espécie no Brasil ou sacar por lá?',
        a: 'Depende da margem de cada ponta. Saques em caixas eletrônicos de bancos europeus e pagamentos por cartão em euro costumam chegar mais perto da referência interbancária do que qualquer balcão de aeroporto, de um lado ou do outro.',
      },
    ],
  },

  'gbp-brl': {
    lead:
      'Converter libra esterlina (GBP) em real brasileiro (BRL) é multiplicar o valor em libras pela cotação GBP/BRL do momento; uma libra vale bastante mais que um real. '
      + 'A conversão é trabalho do {{app}}, gratuito nas duas lojas. Esta página trata do que costuma confundir nesse par: a direção da cotação e a pontuação dos preços britânicos.',
    h2: 'Quem converte libra esterlina em real brasileiro',
    body: [
      'A libra entra na vida do brasileiro por dois caminhos: o curso de inglês em Londres, Brighton ou Manchester, e a compra em loja britânica que despacha para cá. O intercâmbio é o caso mais pesado, porque envolve mensalidade, acomodação e caução pagos com meses de antecedência — três conversões em datas diferentes, cada uma com a cotação do seu dia.',
      'Há duas armadilhas de leitura. A primeira é a direção: o mercado cota a libra como moeda base, na forma GBP/USD, então a manchete diz quantos dólares vale uma libra, e não o contrário. A segunda é a escrita dos números. O varejo britânico usa ponto para separar os centavos e vírgula para separar os milhares, exatamente o inverso da convenção brasileira, e ler o preço no formato errado muda a conta por um fator de mil.',
      'No comércio britânico o VAT já está incluído na etiqueta, como aqui. Mas o Reino Unido encerrou o tax free para visitantes no fim de 2020: quem viaja não recupera mais o imposto em compras feitas na Inglaterra, na Escócia ou no País de Gales, ao contrário do que ainda vale na União Europeia.',
    ],
    tips: {
      h3: 'Notas práticas para GBP/BRL',
      items: [
        'Escócia e Irlanda do Norte emitem cédulas próprias: é a mesma libra, com a mesma cotação.',
        'Preços britânicos usam ponto no lugar da vírgula decimal, então confira a pontuação antes de converter.',
        'Mensalidade, acomodação e caução costumam ser cobradas em datas distintas; converta cada parcela no dia em que ela sai.',
        'No terminal do Reino Unido, escolha ser cobrado em libras e nunca em reais.',
        'Uma libra se divide em 100 pence, e o troco em moedas pequenas se acumula rápido em viagem curta.',
      ],
    },
    faq: [
      {
        q: 'Por que as notícias falam em GBP/USD e não em USD/GBP?',
        a: 'Por convenção de mercado a libra sempre aparece como moeda base, então o número da manchete é quantos dólares valem uma libra. No {{app}} basta inverter as duas moedas para ler o par no sentido que interessa a você.',
      },
      {
        q: 'Ainda existe devolução de imposto para turista no Reino Unido?',
        a: 'Não para compras levadas na bagagem. O regime de devolução do VAT a visitantes foi encerrado no fim de 2020 na Grã-Bretanha, então o preço da etiqueta, com imposto dentro, é o valor que você deve converter.',
      },
    ],
  },

  'ars-brl': {
    lead:
      'Converter peso argentino (ARS) em real brasileiro (BRL) devolve um número bem menor que o digitado: são muitos pesos para cada real, e essa proporção muda depressa. '
      + 'O {{app}} refaz essa conta no celular a qualquer hora, com ou sem sinal. Esta página serve tanto a quem vai a Buenos Aires quanto a quem atende argentino no litoral.',
    h2: 'Quem converte peso argentino em real brasileiro',
    body: [
      'Este é o par mais bidirecional da lista. Buenos Aires, Bariloche e Mendoza estão entre os destinos internacionais mais procurados por brasileiros, e no verão o fluxo se inverte: argentinos lotam Florianópolis, Balneário Camboriú e Bombinhas, e o comerciante do litoral catarinense precisa saber quanto vale o peso que está na mão do cliente.',
      'A dificuldade do par é a velocidade. A Argentina conviveu com inflação alta e, por períodos longos, com mais de uma cotação simultânea para o dólar — a oficial e as paralelas —, o que fez o peso perder valor em ritmo que nenhuma tabela impressa acompanha. Um preço anotado no caderno há três meses não diz mais nada sobre o preço de hoje.',
      'Some a isso o fato de que quase ninguém precifica ARS/BRL de forma direta. Os balcões dos dois lados montam o par via dólar, então o que chega ao cliente é uma taxa cruzada com duas margens embutidas. Levar dólar em espécie e trocar já na Argentina virou hábito do turista brasileiro justamente por causa dessa engrenagem.',
    ],
    tips: {
      h3: 'Notas práticas para ARS/BRL',
      items: [
        'Confira a cotação no dia da viagem, e não na semana em que comprou a passagem: o par anda rápido.',
        'Peso argentino e peso uruguaio usam o mesmo cifrão; em Buenos Aires, $ é peso e nunca dólar.',
        'A Argentina escreve números como o Brasil, com ponto nos milhares, então conte os zeros com calma.',
        'Quem vende para turista argentino no litoral deve repassar a cotação do dia, não a da semana anterior.',
        'Salve o par no {{app}} antes de cruzar a fronteira: ele converte pelo último valor guardado mesmo sem roaming.',
      ],
    },
    faq: [
      {
        q: 'Por que a cotação ARS/BRL muda tanto de um mês para o outro?',
        a: 'Porque a Argentina atravessou períodos longos de inflação alta e de controles cambiais, o que empurra o peso para baixo de forma contínua. É o par desta lista em que um número antigo envelhece mais rápido e engana mais.',
      },
      {
        q: 'Levo real, dólar ou peso para a Argentina?',
        a: 'Na prática o dólar em espécie é o mais aceito nos balcões argentinos, e o real quase sempre recebe cotação pior. Converta o valor final antes de decidir, contando a margem das duas trocas quando o caminho passa pelo dólar.',
      },
    ],
  },

  'cad-brl': {
    lead:
      'Converter dólar canadense (CAD) em real brasileiro (BRL) usa uma cotação própria, que não é a mesma do dólar americano apesar do cifrão compartilhado. '
      + 'No {{app}} cada uma tem o seu código ISO, sem risco de trocar uma pela outra. Esta página reúne o que pesa numa mudança para o Canadá, do imposto ao envio mensal.',
    h2: 'Quem converte dólar canadense em real brasileiro',
    body: [
      'O Canadá virou projeto de vida para uma faixa grande de brasileiros: college em Toronto ou Vancouver, permissão de trabalho, residência permanente. Isso muda a natureza do par. Não é a cotação de uma viagem de dez dias, é a cotação de uma mudança que passa por comprovação de fundos, mensalidade, aluguel e, mais tarde, pelo dinheiro que volta todo mês para a família aqui.',
      'A primeira confusão é o símbolo. Dólar canadense e dólar americano dividem o cifrão, e um preço canadense lido como americano parece uma pechincha que não existe. Procure o prefixo CA$ ou o código ISO antes de calcular.',
      'A segunda é o imposto. No Brasil a etiqueta já é o preço final; no Canadá o GST federal e o imposto provincial entram só no caixa, e a gorjeta esperada no restaurante ainda vem por cima. Converter a etiqueta subestima a conta. Vale notar ainda que as duas moedas são de países exportadores de matéria-prima: o canadense acompanha o petróleo, o real acompanha minério e grãos, e por isso o par às vezes fica quieto enquanto ambos se mexem contra o dólar americano.',
    ],
    tips: {
      h3: 'Notas práticas para CAD/BRL',
      items: [
        'Confira o código ISO antes de converter um preço achado na internet: CA$ e US$ compartilham o mesmo cifrão.',
        'Some GST e imposto provincial ao valor da etiqueta antes da conversão; a alíquota muda de província para província.',
        'A moeda de um centavo deixou de ser distribuída em 2013 e pagamentos em dinheiro são arredondados de cinco em cinco centavos.',
        'A comprovação de fundos do visto de estudo é feita em dólar canadense; converta na data do depósito.',
        'Quem envia dinheiro todo mês ganha mais acompanhando o par do que trocando de operadora.',
      ],
    },
    faq: [
      {
        q: 'O preço anunciado no Canadá já vem com imposto?',
        a: 'Não. O GST federal e o imposto provincial são somados no caixa e variam conforme a província, então a etiqueta fica abaixo do que sai do cartão. Converta o total final da compra, e não o valor anunciado na prateleira.',
      },
      {
        q: 'Por que o dólar canadense e o real às vezes andam na mesma direção?',
        a: 'Porque os dois países vivem de exportar matéria-prima: o canadense é sensível ao petróleo e o real, a minério de ferro e grãos. Quando o ciclo de commodities gira, as duas moedas costumam reagir juntas contra o dólar americano.',
      },
    ],
  },

  'jpy-brl': {
    lead:
      'O iene japonês (JPY) não tem centavos — expoente zero na ISO 4217 —, então converter JPY para BRL parte de um número grande e chega a um pequeno. '
      + 'O {{app}} cuida das casas decimais para você, no Android e no iOS. Esta página explica de onde vêm tantos dígitos e por que o par importa às famílias brasileiras no Japão.',
    h2: 'Quem converte iene japonês em real brasileiro',
    body: [
      'Há décadas o Japão abriga uma das maiores comunidades brasileiras fora do país, concentrada nas prefeituras industriais de Aichi, Shizuoka e Gunma. Para essas famílias JPY/BRL não é curiosidade de mercado: é a conta do fim do mês, quando o salário em ienes precisa virar depósito na conta de alguém no Brasil.',
      'O formato assusta antes da matemática. O iene não tem subdivisão em circulação, então um almoço custa quatro dígitos e um aluguel, seis. Quem lê o preço como se houvesse duas casas decimais imagina valores cem vezes maiores do que os reais. Com números tão longos, conferir a quantidade de dígitos antes de converter evita errar a conta por uma ordem de grandeza inteira.',
      'Na outra ponta estão os turistas. O Japão entrou de vez no roteiro brasileiro, e a política monetária japonesa correu em trilho próprio por muitos anos, o que dá ao par oscilações longas: a mesma viagem pode sair bem diferente de um ano para o outro. Olhar o gráfico de vários anos ajuda a perceber se o momento é atípico ou corriqueiro.',
    ],
    tips: {
      h3: 'Notas práticas para JPY/BRL',
      items: [
        'O iene não tem centavos, então todo valor japonês entra na conversão como número inteiro.',
        'O Japão ainda circula muito dinheiro vivo, e os caixas eletrônicos de lojas de conveniência são os mais confiáveis para cartão estrangeiro.',
        'Envio mensal ganha com regularidade e volume: compare quantos reais chegam à conta, não a tarifa da vitrine.',
        'O modo offline do {{app}} resolve o metrô de Tóquio, onde o sinal some e o preço aparece só em ienes.',
        'Lojas com isenção para visitante processam a venda em iene antes de qualquer conversão.',
      ],
    },
    faq: [
      {
        q: 'Por que preço japonês não tem centavos?',
        a: 'O iene tem expoente de unidade menor igual a zero na ISO 4217, ou seja, não existe subdivisão em circulação. Um preço de vários milhares de ienes é corriqueiro no dia a dia, e não um erro de digitação nem de leitura.',
      },
      {
        q: 'Qual é a melhor forma de mandar iene para o Brasil?',
        a: 'Não há resposta única, mas o critério é sempre o mesmo: compare quantos reais entram na conta de destino, já com margem e tarifa descontadas. A referência interbancária que o {{app}} mostra serve de ponto de partida para essa comparação.',
      },
    ],
  },

  'aud-brl': {
    lead:
      'Converter dólar australiano (AUD) em real brasileiro (BRL) é multiplicar o valor em dólares australianos pela cotação AUD/BRL, que não tem relação direta com o dólar americano. '
      + 'Deixe o cálculo com o {{app}}, que funciona mesmo fora de área de cobertura. Esta página fica com o contexto: intercâmbio longo, GST embutido no preço e minério de ferro.',
    h2: 'Quem converte dólar australiano em real brasileiro',
    body: [
      'A Austrália é o destino clássico do intercâmbio longo brasileiro: visto de estudante com permissão de trabalho, curso de inglês em Sydney, Gold Coast ou Melbourne, e um orçamento que precisa fechar em dólares australianos por seis meses ou mais. Nesse formato a cotação não é consultada uma vez só — é consultada toda semana, porque a mensalidade vence numa data e o aluguel, em outra.',
      'Duas diferenças mudam a conta em relação ao que se espera aqui. O GST australiano já está dentro do preço anunciado, então a etiqueta é o valor final. E gorjeta não é praxe: o total do restaurante convertido é o total mesmo, sem acréscimo mental de dez por cento.',
      'O par tem ainda uma peculiaridade que quase ninguém nota. Austrália e Brasil estão entre os maiores exportadores de minério de ferro do planeta e vendem para o mesmo comprador principal, a China. Quando a demanda chinesa aperta ou afrouxa, as duas moedas tendem a reagir na mesma direção, e o AUD/BRL costuma se mexer menos do que cada perna isolada contra o dólar americano.',
    ],
    tips: {
      h3: 'Notas práticas para AUD/BRL',
      items: [
        'O GST australiano já está embutido no valor anunciado: converta a etiqueta e pronto.',
        'Gorjeta não é costume na Austrália, então a conta do restaurante não tem acréscimo esperado.',
        'Sites australianos escrevem A$ para desfazer a dúvida com o dólar americano; procure essa marca antes de calcular.',
        'As distâncias australianas deixam trechos longos sem cobertura, e o modo offline do {{app}} vale nesse cenário.',
        'Orçamento de intercâmbio é uma sequência de pagamentos: converta cada um na sua data, não tudo de uma vez.',
      ],
    },
    faq: [
      {
        q: 'O preço anunciado na Austrália já inclui imposto?',
        a: 'Sim. O GST vem dentro do valor anunciado, então o número convertido é o que será cobrado de fato. É a mesma lógica da etiqueta brasileira, e o oposto do que acontece nos Estados Unidos e no Canadá, onde o imposto entra no caixa.',
      },
      {
        q: 'Por que dólar australiano e real reagem às mesmas notícias?',
        a: 'Porque as duas economias exportam matéria-prima para os mesmos compradores, com destaque para o minério de ferro vendido à China. Notícia sobre demanda chinesa mexe nas duas moedas ao mesmo tempo, o que costuma amortecer o par.',
      },
    ],
  },

  'chf-brl': {
    lead:
      'Converter franco suíço (CHF) em real brasileiro (BRL) devolve um número alto: o franco é moeda de refúgio e tende a subir justamente quando o real cai. '
      + 'A conta em si é feita pelo {{app}}, gratuito nas duas lojas. Esta página explica por que esse par anda em episódios e o que isso faz com um orçamento suíço.',
    h2: 'Quem converte franco suíço em real brasileiro',
    body: [
      'A Suíça não usa o euro e não faz parte da União Europeia, e essa é a informação que mais falta no roteiro de brasileiro pela Europa. Quem chega de trem vindo de Milão ou de Paris descobre no primeiro café que o país tem moeda própria, e que pagar em euro num comércio suíço significa aceitar a cotação de balcão do estabelecimento — quase sempre pior do que a do cartão em francos.',
      'O franco também aparece fora do turismo. Ele é uma das moedas para onde o dinheiro corre em momentos de estresse global, e o real está entre as primeiras a sofrer nesses mesmos momentos. O resultado é um par que soma os dois movimentos em vez de compensá-los, e que por isso oscila mais do que a média das moedas desta lista.',
      'Para quem viaja, a tradução prática é simples: orçamento suíço feito com meses de antecedência merece revisão antes do embarque. Genebra e Zurique aparecem com frequência entre as cidades mais caras do mundo em levantamentos de custo de vida, e a cotação é apenas metade da explicação.',
    ],
    tips: {
      h3: 'Notas práticas para CHF/BRL',
      items: [
        'A menor moeda em circulação na Suíça é a de 5 centavos, e pagamentos em dinheiro são arredondados para múltiplos dela.',
        'Comércios suíços aceitam euro por cortesia, mas o troco volta em franco e a conversão é escolhida pelo próprio lojista.',
        'O franco é escrito como CHF ou Fr., sem risco de confusão com o cifrão de outras moedas.',
        'Liechtenstein também usa o franco suíço, com a mesma cotação e as mesmas cédulas.',
        'Olhe o gráfico de longo prazo no {{app}} antes de fechar orçamento: o franco se move em episódios, não em linha reta.',
      ],
    },
    faq: [
      {
        q: 'Dá para pagar em euro na Suíça?',
        a: 'Em muitos pontos turísticos sim, mas a conversão é feita pelo próprio comércio, com a cotação que ele escolher, e o troco volta em franco. Pagar em franco, no cartão ou em espécie, costuma ficar mais perto da referência.',
      },
      {
        q: 'Por que o CHF/BRL se mexe tanto em momento de crise?',
        a: 'Porque os dois lados reagem ao mesmo susto em direções opostas: o franco atrai capital quando cresce a aversão ao risco, enquanto o real, como moeda emergente, perde valor. Os dois movimentos se somam dentro do mesmo par.',
      },
    ],
  },

  'brl-usd': {
    lead:
      'Converter real brasileiro (BRL) em dólar americano (USD) devolve uma fração do valor digitado, então vale aumentar as casas decimais para não perder precisão. '
      + 'É o sentido de quem recebe em real e precisa saber quanto aquilo vale lá fora; a conta fica com o {{app}}, e esta página, com o que vem depois do câmbio.',
    h2: 'Quem converte real brasileiro em dólar americano',
    body: [
      'Lido neste sentido, o par muda de dono. Não é mais o turista: é o profissional que fatura para cliente estrangeiro, o desenvolvedor contratado como pessoa jurídica por empresa dos Estados Unidos e o exportador de café, soja ou minério que recebe em dólar mas paga folha e insumo em real.',
      'Para quem fatura no exterior, o risco está no calendário. O preço é acertado num dia e o dinheiro entra semanas depois, quando o contrato de câmbio é liquidado por outro número. Um contrato de valor fixo vira, sem que ninguém tenha decidido isso, uma posição cambial. Bancos e fintechs cobram esse fechamento na forma de margem sobre a referência, e essa margem costuma ser negociável a partir de certo volume — o que só adianta pedir se você souber qual é a referência.',
      'Existe também o uso doméstico do sentido inverso: dimensionar em dólar uma reserva, um investimento fora do país ou o custo de uma viagem já orçada em real. Aí o que importa é a ordem de grandeza, e um toque para inverter as moedas no {{app}} entrega as duas leituras de uma vez.',
    ],
    tips: {
      h3: 'Notas práticas para BRL/USD',
      items: [
        'Aumente as casas decimais no {{app}}: neste sentido o resultado é menor que o valor digitado e some no arredondamento padrão.',
        'Quem fatura fora carrega o risco cambial entre a data da proposta e a data da liquidação do contrato.',
        'A margem do fechamento de câmbio tende a cair com volume; peça a cotação líquida em vez da tarifa.',
        'Acompanhe o gráfico de um ano para saber se o momento é fora do padrão antes de antecipar ou adiar um fechamento.',
      ],
    },
    faq: [
      {
        q: 'Recebo em dólar do exterior: vale a cotação do dia do serviço ou a do pagamento?',
        a: 'Vale a do fechamento do contrato de câmbio, ou seja, o dia em que o dinheiro é convertido e cai na conta. Entre a proposta e essa data o resultado em real pode mudar bastante, e quem carrega a diferença é quem emitiu a fatura.',
      },
      {
        q: 'Por que o resultado de real para dólar aparece com tão poucos dígitos?',
        a: 'Porque um real compra uma fração de dólar, então o número convertido fica menor que o valor inserido. Ampliar as casas decimais no {{app}} evita perder informação em quantias pequenas, e inverter as moedas mostra a mesma conta no outro sentido.',
      },
    ],
  },

  'brl-eur': {
    lead:
      'Converter real brasileiro (BRL) em euro (EUR) devolve uma fração do valor digitado: são vários reais para cada euro, e não o contrário. '
      + 'O {{app}} inverte o par com um toque e guarda a última cotação para consulta sem internet. Esta página trata do custo real de mandar dinheiro daqui para a zona do euro.',
    h2: 'Quem converte real brasileiro em euro',
    body: [
      'Este sentido pertence a quem está de saída ou já saiu. Portugal recebe a maior comunidade brasileira da União Europeia, e atrás dela vem uma lista de despesas em euro que precisam ser dimensionadas em real: matrícula e mensalidade — propina, no vocabulário português —, caução e renda do apartamento, taxas do processo de residência, seguro. Cada uma com o seu prazo e a sua cotação.',
      'Do lado das empresas, o euro é a moeda de boa parte da pauta que o Brasil vende à Europa: café, celulose, suco de laranja, carne. O exportador recebe em euro e paga custo em real, o que transforma este par numa conta de margem, e não numa conta de viagem.',
      'Um detalhe operacional pega muita gente. Mandar dinheiro do Brasil para uma conta na zona do euro tem custo na saída — margem, tarifa e imposto de câmbio —, enquanto transferir entre dois países da zona do euro pela área SEPA é barato e às vezes gratuito. Quem já mantém conta em euro do outro lado paga o pedágio uma vez só, na travessia.',
    ],
    tips: {
      h3: 'Notas práticas para BRL/EUR',
      items: [
        'Amplie as casas decimais: neste sentido o resultado é sempre menor que a quantia digitada.',
        'Propina, caução e taxas de residência vencem em datas diferentes; converta cada uma no dia do pagamento.',
        'Transferências dentro da zona do euro pela área SEPA custam pouco; o caro é o trecho Brasil–Europa.',
        'Compare quantos euros entram na conta de destino, e não a tarifa anunciada por quem envia.',
        'O gráfico de cinco anos no {{app}} mostra se o euro está caro em relação ao próprio histórico.',
      ],
    },
    faq: [
      {
        q: 'O que encarece mandar dinheiro do Brasil para Portugal?',
        a: 'A margem aplicada sobre a cotação de referência, a tarifa fixa de quem envia e o imposto sobre a operação de câmbio. Depois que o dinheiro chegou, movê-lo dentro da zona do euro pela área SEPA custa pouco ou nada.',
      },
      {
        q: 'Quanto vale meu salário em real na Europa?',
        a: 'Converta o valor mensal no {{app}} para ter a ordem de grandeza, lembrando que poder de compra não acompanha cotação: aluguel, transporte e alimentação têm preços relativos bem diferentes dos brasileiros.',
      },
    ],
  },

  'eur-usd': {
    lead:
      'Converter euro (EUR) em dólar americano (USD) é aplicar a cotação EUR/USD, o par mais negociado do mundo e a base das cotações de euro no Brasil. '
      + 'Quem calcula é o {{app}}, de graça e sem cadastro. Esta página explica por que esse par de Frankfurt decide o preço do euro no balcão de São Paulo.',
    h2: 'Por que o EUR/USD importa para quem está no Brasil',
    body: [
      'Nenhuma mesa de câmbio brasileira forma preço de euro do zero. O real é cotado contra o dólar, o dólar é cotado contra o euro, e o EUR/BRL que aparece na tela é o produto dos dois. Isso significa que uma alta do euro contra o dólar em Frankfurt chega ao balcão de São Paulo mesmo sem que nada tenha mudado por aqui.',
      'A consequência prática aparece no planejamento de viagem. Muita gente compra dólar em espécie por hábito e por disponibilidade, mesmo indo para a Europa, e troca dólar por euro depois de desembarcar. São duas operações e duas margens sobre o mesmo dinheiro. Saber onde está o EUR/USD ajuda a decidir se essa ponte compensa ou se é melhor comprar euro direto.',
      'Para importador e investidor o par também serve de referência de preço. Commodities e boa parte dos contratos internacionais são cotados em dólar, então um movimento no EUR/USD muda o custo em euro de um mesmo produto sem que o produto tenha mudado de preço.',
    ],
    tips: {
      h3: 'Notas práticas para EUR/USD',
      items: [
        'Comprar dólar aqui e trocar por euro na Europa paga duas margens sobre a mesma quantia.',
        'O par reage a decisões de juros do Banco Central Europeu e do Federal Reserve, publicadas em calendário conhecido.',
        'Euro e dólar têm duas casas decimais, então a conversão entre eles não perde nada no arredondamento.',
        'Se o roteiro passa por zona do euro e Estados Unidos, converta cada trecho na moeda local em vez de misturar.',
      ],
    },
    faq: [
      {
        q: 'Compensa comprar dólar no Brasil para gastar em euro na Europa?',
        a: 'Raramente. São duas conversões, cada uma com a margem de quem vende, e o EUR/USD ainda pode andar entre uma e outra. Comprar euro direto ou pagar em euro no cartão costuma ficar mais perto da referência interbancária.',
      },
      {
        q: 'Por que o euro muda de preço no Brasil sem nenhuma notícia brasileira?',
        a: 'Porque o EUR/BRL é uma taxa cruzada montada a partir do dólar. Se o euro sobe contra o dólar no mercado internacional, o euro sobe em real mesmo com o dólar parado frente à moeda brasileira.',
      },
    ],
  },

  'usd-eur': {
    lead:
      'Converter dólar americano (USD) em euro (EUR) é a leitura invertida do par mais negociado do mercado, e devolve um número menor que o digitado. '
      + 'Um toque no {{app}} inverte o par e evita ler a cotação ao contrário. Esta página trata do que fazer com dólar em mãos quando o destino é a zona do euro.',
    h2: 'Quem converte dólar americano em euro',
    body: [
      'Para o público brasileiro este sentido tem um dono bem definido: quem já tem dólar na mão. Conta global, investimento fora do país, pagamento de cliente americano, papel-moeda que sobrou de uma ida a Miami. A pergunta é quanto disso vira euro sem precisar passar de novo pelo real.',
      'A resposta curta é: não passe. Transformar dólar em real e depois real em euro cobra duas margens e, no Brasil, ainda submete cada etapa ao imposto sobre operação de câmbio. Trocar dólar por euro de forma direta, onde for possível, elimina a perna do meio e um dos custos.',
      'Vale entender também por que “o dólar subiu no mundo” quase sempre quer dizer este par. O índice DXY, o mais citado para medir a força da moeda americana, tem o euro como componente dominante, com peso próximo de 58 por cento. Ou seja, o índice é em grande parte uma leitura de USD/EUR, e não uma média equilibrada de todas as moedas do planeta.',
    ],
    tips: {
      h3: 'Notas práticas para USD/EUR',
      items: [
        'Trocar dólar por euro sem passar pelo real elimina uma margem e uma incidência de imposto de câmbio.',
        'O euro responde por cerca de 58 por cento do índice DXY, então “dólar forte” é, em boa medida, este par.',
        'Nos Estados Unidos o imposto sobre vendas entra no caixa; na zona do euro o IVA já está na etiqueta.',
        'Balcões recusam cédulas de dólar rasgadas ou muito antigas, ainda que válidas; confira o papel antes de embarcar.',
        'Inverter as duas moedas no {{app}} evita o erro clássico de ler o par no sentido contrário.',
      ],
    },
    faq: [
      {
        q: 'O que significa dizer que o dólar está forte?',
        a: 'Normalmente significa que ele subiu contra a cesta medida pelo índice DXY, na qual o euro tem o maior peso, perto de 58 por cento. Por isso a frase é, na prática, uma afirmação sobre a relação entre dólar e euro.',
      },
      {
        q: 'Tenho dólar e vou para a Europa: troco aqui ou lá?',
        a: 'O que decide é a margem de cada balcão, não o país. O que quase nunca vale a pena é o caminho dólar, real e euro, porque cada etapa cobra a sua e o imposto de câmbio brasileiro incide em cada operação separadamente.',
      },
    ],
  },
},

  ru: {
  'usd-rub': {
    lead:
      'Чтобы пересчитать доллары США (USD) в российские рубли (RUB), умножьте долларовую сумму на текущий курс USD/RUB — результат всегда больше исходного числа. '
      + 'Сам пересчёт делает приложение {{app}}: бесплатно на Android и iOS, работает и с выключенным интернетом. Страница объясняет другое — почему официальная цифра регулятора и касса обменника никогда не сходятся.',
    h2: 'Кому нужен курс доллара к рублю',
    body: [
      'USD/RUB — самая просматриваемая котировка в стране, и следят за ней далеко не только те, кто собирается что-то покупать за валюту. Доллар давно работает как бытовая единица счёта: в нём прикидывают стоимость техники, аренды, ремонта и поездки, даже когда платить придётся рублями и никакого обмена не планируется.',
      'Путаница из года в год одна и та же: официальный курс Банка России — это не та цифра, по которой вам продадут наличные. Официальные курсы устанавливаются по рабочим дням, публикуются с точностью до четырёх знаков после запятой и действуют со следующего календарного дня; в выходные и праздники продолжает работать последний установленный. Обменный пункт добавляет к этому свой спред между покупкой и продажей, и для наличных он заметно шире, чем для безналичной конвертации по карте.',
      'Отсюда простое правило чтения: справочная цифра — это база для сравнения, а не то, что вы получите на кассе. Разрыв между базой и котировкой конкретного банка и есть настоящая цена обмена, и по вечерам и выходным, когда межбанковский рынок стоит, этот разрыв обычно шире всего.',
    ],
    tips: {
      h3: 'Что полезно помнить про пару USD/RUB',
      items: [
        'Официальный курс нужен для отчётности, налогов и таможенных платежей, а не для покупки наличных.',
        'Смотрите обе цифры обменника — покупку и продажу; разница между ними и есть его заработок.',
        'У доллара и рубля по два знака после запятой, поэтому на округлении при пересчёте ничего не теряется.',
        'Котировка реагирует на решения по ставке ФРС и Банка России — даты обоих заседаний известны заранее.',
        'Закрепите USD/RUB в избранном {{app}}, чтобы пара открывалась первой строкой.',
      ],
    },
    faq: [
      {
        q: 'Чем официальный курс Банка России отличается от курса в обменнике?',
        a: 'Официальный курс регулятор устанавливает по рабочим дням, и применяется он к бухгалтерии, налогам и таможне. Обменный пункт закладывает в цифру собственную маржу и держит разные значения на покупку и продажу, поэтому совпадения с официальной величиной ждать не стоит.',
      },
      {
        q: 'Почему в выходные курс доллара как будто замирает?',
        a: 'В субботу и воскресенье межбанковский рынок не торгуется, поэтому справочная величина остаётся пятничной. Те, кто всё же меняет валюту в выходные, расширяют спред, закладывая риск понедельничного движения.',
      },
    ],
  },

  'eur-rub': {
    lead:
      'Пересчёт евро (EUR) в российские рубли (RUB) — это умножение суммы в евро на текущий курс EUR/RUB, и в рублях всегда выходит число больше исходного. '
      + 'Считает эту пару приложение {{app}} — бесплатно, на Android и iOS, по сохранённым данным даже без сети. Страница же объясняет, почему евро идёт к рублю своим путём, отдельно от доллара.',
    h2: 'Зачем в России смотрят курс евро',
    body: [
      'Евро здесь — валюта поездок и счетов, а не повседневных расчётов. Котировка нужна, когда речь заходит о брони отеля и шенгенском сборе, об оплате обучения, о заказе в европейском интернет-магазине или о переводе родственникам, живущим в еврозоне. Суммы обычно разовые и крупные, поэтому ошибка в разряде обходится дороже, чем в мелких бытовых пересчётах.',
      'Техническая особенность: EUR/RUB — это кросс-курс. На него влияют сразу два движения: то, что происходит с парой евро-доллар на мировом рынке, и то, что происходит с рублём. Поэтому евро может подорожать к рублю в день, когда доллар к рублю почти не сдвинулся, и наоборот. С 2005 по 2014 год ориентиром служила бивалютная корзина из доллара и евро; такого ориентира давно нет, а привычка держать в голове обе цифры осталась.',
      'Для покупателя важна ещё география: евро — единая валюта стран еврозоны, и их список со временем пополняется — Хорватия перешла на евро 1 января 2023 года. Один курс закрывает всю поездку по континенту, сколько бы границ вы ни пересекли.',
    ],
    tips: {
      h3: 'Практические заметки по EUR/RUB',
      items: [
        'На европейском терминале выбирайте списание в евро: предложение посчитать в рублях — конвертация продавца со своей наценкой.',
        'Ценники в магазинах еврозоны включают НДС, поэтому пересчитанная сумма и есть то, что спишут.',
        'Евро и рубль используют по две цифры после запятой: центы и копейки переводятся без потерь.',
        'Пару двигают заседания Европейского центрального банка, календарь которых публикуется на год вперёд.',
      ],
    },
    faq: [
      {
        q: 'Почему евро дорожает к рублю в дни, когда доллар стоит на месте?',
        a: 'Потому что величина считается как кросс-курс. Если евро прибавляет к доллару на мировом рынке, а доллар к рублю не меняется, евро к рублю всё равно уходит вверх — движение приходит со стороны пары евро-доллар.',
      },
      {
        q: 'Где пригодится один и тот же курс евро?',
        a: 'Во всех странах еврозоны — от Португалии до Финляндии, — а за её пределами ещё в Черногории, Косове, Монако, Сан-Марино, Андорре и Ватикане. Отдельно считать по каждой стране маршрута не нужно, цифра одна.',
      },
    ],
  },

  'cny-rub': {
    lead:
      'Пересчёт китайских юаней (CNY) в российские рубли (RUB) — умножение суммы в юанях на текущий курс CNY/RUB, и в рублях получается число ощутимо больше. '
      + 'Пересчётом занимается приложение {{app}}: бесплатное, для Android и iOS, работает и без сети. Страница разбирает устройство самой пары — от двух разных курсов юаня до путаницы в его названиях.',
    h2: 'Юань превратился в бытовую котировку',
    body: [
      'Китай — крупнейший торговый партнёр России, и юань за несколько лет прошёл путь от экзотики до валюты, которую держат на вкладах и проверяют каждое утро. В 2023 году юань вышел на первое место среди иностранных валют по объёму биржевых торгов в России, а расчёты с китайскими поставщиками в CNY для небольших компаний перестали быть чем-то особенным.',
      'Больше всего новичков сбивают названия и то, что курсов на самом деле два. Валюта называется жэньминьби («народные деньги»), её счётная единица — юань, а в стандарте ISO 4217 закреплён код CNY. При этом CNY — внутренний, оншорный курс, который Народный банк Китая удерживает в дневном коридоре вокруг утреннего центрального паритета, а CNH — офшорный, торгуемый в Гонконге заметно свободнее. Значения близкие, но не одинаковые, и поставщик может выставить счёт по любому из них.',
      'У покупателей на китайских площадках добавляется третий слой: витрина показывает цену в юанях, карта списывает рубли, а между ними стоит конвертация платёжной системы. Прикинуть рублёвую сумму по справочной цифре заранее — единственный способ понять, во сколько обошлась сама конвертация.',
    ],
    tips: {
      h3: 'Что стоит знать про юань',
      items: [
        'Жэньминьби — имя валюты, юань — её единица; в стандарте ISO 4217 используется код CNY.',
        'Юань делится на 10 цзяо, а цзяо — на 10 фэней, но фэни в рознице давно не встречаются.',
        'Уточняйте у поставщика, по какой котировке он считает: по оншорной CNY или офшорной CNH.',
        'Графики за пять лет в {{app}} показывают, насколько узко ведут оншорную величину.',
      ],
    },
    faq: [
      {
        q: 'Чем CNY отличается от CNH?',
        a: 'CNY — юань внутри материкового Китая, который регулятор ежедневно ограничивает коридором вокруг центрального паритета. CNH — офшорный юань в Гонконге, он свободнее. Значения обычно рядом, но совпадают редко, и счёт может быть выставлен по любому.',
      },
      {
        q: 'Юань или жэньминьби — как говорить правильно?',
        a: 'Жэньминьби — имя самой валюты, юань — её счётная единица. Сказать «сто юаней» так же нормально, как «сто рублей», а слово «жэньминьби» уместно, когда речь идёт о валюте в целом.',
      },
    ],
  },

  'try-rub': {
    lead:
      'Пересчитать турецкие лиры (TRY) в российские рубли (RUB) — значит умножить сумму в лирах на текущий курс TRY/RUB, который меняется быстрее большинства пар. '
      + 'Считает лиры приложение {{app}} — бесплатно на Android и iOS, в том числе без интернета. Страница нужна для другого: понять, почему турецкие цены живут по своим правилам.',
    h2: 'Лира, отель и высокая инфляция',
    body: [
      'Турция — самое массовое зарубежное направление у российских туристов, поэтому пара интересует прежде всего тех, кто считает бюджет поездки в Анталью, Стамбул или Бодрум. Особенность в том, что лира живёт при высокой инфляции: внутренние цены пересматриваются часто, и котировка, записанная весной, к августу описывает уже другую страну.',
      'Практическое следствие: планировать по цифре трёхмесячной давности бессмысленно. Отели, трансферы и экскурсии это прекрасно понимают и нередко выставляют прайс в евро или долларах, а в лиры пересчитывают уже на месте по собственному внутреннему курсу, который от рыночного отличается в свою пользу.',
      'Есть и историческая деталь, из-за которой старые тексты читаются странно. В 2005 году в стране провели деноминацию, убрав с номиналов шесть нулей, а знак ₺ ввели только в 2012 году. Поэтому суммы в миллионах лир из статей нулевых относятся к прежней валюте, и пересчитывать их по сегодняшней величине нельзя.',
    ],
    tips: {
      h3: 'Практика для TRY/RUB',
      items: [
        'Обменные конторы в городе почти всегда дают лучше, чем стойка в аэропорту или ресепшен отеля.',
        'На терминале выбирайте списание в лирах: пересчёт в рубли на стороне продавца — отдельная наценка.',
        'Цену, названную неделю назад, пересчитывайте заново перед оплатой, а не при бронировании.',
        'Лира делится на 100 курушей, так что округление до копеек проблем не создаёт.',
      ],
    },
    faq: [
      {
        q: 'Почему в Турции жильё и туры часто оценивают в евро, а не в лирах?',
        a: 'При высокой инфляции продавцу невыгодно фиксировать лировую цену на месяцы вперёд. Долгосрочные договоры и туристические услуги поэтому нередко номинируют в евро или долларах, а в лиры переводят в день оплаты.',
      },
      {
        q: 'Что означают старые цены в миллионах турецких лир?',
        a: 'Это валюта до деноминации 2005 года, когда с номиналов сняли шесть нулей. К нынешним суммам они отношения не имеют, и переводить такие цифры по сегодняшней котировке некорректно.',
      },
    ],
  },

  'aed-rub': {
    lead:
      'Курс дирхама ОАЭ (AED) к российскому рублю (RUB) движется почти исключительно из-за рубля: дирхам жёстко привязан к доллару США и сам по себе не колеблется. '
      + 'Пересчитывает пару приложение {{app}} — бесплатно, на Android и iOS, и без связи тоже. Страница объясняет, что эта привязка означает для того, кто меняет деньги в Дубае.',
    h2: 'Дубай, привязка к доллару и цена посредника',
    body: [
      'Дирхам ОАЭ зафиксирован к доллару США, и держится эта привязка с 1997 года. Это не рыночная величина, а решение эмиссионного регулятора, которое пережило несколько кризисов. Практический смысл для пары AED/RUB прямой: почти вся её динамика — это динамика рубля к доллару, а дирхамовая сторона стоит на месте.',
      'Отсюда следует неочевидное: график AED/RUB и график доллара к рублю — по сути один и тот же рисунок в другом масштабе. Если вы и так следите за долларом, вы уже следите за дирхамом, и отдельно «ловить момент» по дирхаму смысла нет.',
      'Значит, экономить надо не на выборе дня, а на марже посредника. Обменные конторы в торговых центрах и в районе Дейры в Дубае обычно котируют лучше банковских отделений, а хуже всего традиционно стойки в аэропорту. Разница между двумя конторами в одном молле бывает больше, чем недельное движение рубля, — поэтому справочная цифра здесь полезна как линейка: она показывает, сколько стоит услуга обмена, а не сколько стоит валюта.',
    ],
    tips: {
      h3: 'Заметки по AED/RUB',
      items: [
        'Привязка к доллару действует с 1997 года — колебания пары приходят только со стороны рубля.',
        'Дирхам делится на 100 филсов, но монеты мельче 25 филсов в обороте практически не встречаются.',
        'Терминалы в ОАЭ часто предлагают списать сумму в рублях — отказывайтесь и платите в дирхамах.',
        'Сравните котировку конторы со справочной цифрой: разрыв между ними и есть её комиссия.',
      ],
    },
    faq: [
      {
        q: 'Курс дирхама к рублю вообще меняется?',
        a: 'Меняется, но не из-за дирхама. Он привязан к доллару США с 1997 года, поэтому колебания пары — это колебания рубля. График повторяет график доллара к рублю с точностью до масштаба.',
      },
      {
        q: 'Где в ОАЭ менять деньги выгоднее?',
        a: 'Разброс между обменными конторами и банковскими отделениями обычно больше, чем недельное движение самой валюты, а худшие условия традиционно в аэропорту. Сравнивайте предложенную цифру со справочной: разрыв и есть стоимость обмена.',
      },
    ],
  },

  'thb-rub': {
    lead:
      'Пересчёт тайских батов (THB) в российские рубли (RUB) — это умножение суммы в батах на текущий курс THB/RUB, и обратное направление считается делением. '
      + 'Считает пару приложение {{app}} — бесплатно, на Android и iOS, и офлайн, что выручает на островах со слабым интернетом. Страница же о самом бате и о том, как устроен обмен денег в Таиланде.',
    h2: 'Бат, зимовка и обменные будки',
    body: [
      'Таиланд у русскоязычной публики — направление зимнее: Пхукет, Самуи, Паттайя, Чиангмай. Пара нужна и туристу на две недели, и тем, кто уезжает на весь сезон, живёт на рублёвые доходы и каждый месяц пересчитывает аренду, байк и продукты в баты.',
      'Главная местная особенность — обменные будки. Специализированные конторы котируют заметно лучше банковских отделений и несравнимо лучше аэропорта, а на их табло обычно висят разные значения для разных номиналов: за стодолларовую банкноту дают больше, чем за двадцатки и десятки. Мятые, надорванные и исписанные купюры могут не принять вовсе, и это не придирка кассира, а общее правило.',
      'Второй расход — снятие наличных. Тайский банк берёт с иностранной карты фиксированную плату за выдачу денег, и она не зависит от суммы. Поэтому одно крупное снятие обходится дешевле пяти мелких, а нужный объём в батах разумно прикинуть заранее, до того как вы встали у банкомата.',
    ],
    tips: {
      h3: 'Практика для THB/RUB',
      items: [
        'Бат делится на 100 сатангов; в чеках они попадаются в основном на заправках и в супермаркетах.',
        'Котировка в обменной конторе зависит от номинала купюры — крупные банкноты меняют выгоднее.',
        'Плата за снятие в тайском банкомате фиксированная, поэтому снимать лучше реже и большими суммами.',
        'Сохраните цифру в {{app}} перед выездом на остров: пересчитать цену на рынке можно и без сети.',
      ],
    },
    faq: [
      {
        q: 'Почему за разные долларовые купюры в Таиланде дают разный курс?',
        a: 'Обменные конторы отдельно котируют крупные и мелкие номиналы: возиться с мелочью им дороже, поэтому за стодолларовую банкноту условия лучше, чем за пятёрки и десятки. Ветхие купюры нередко не принимают совсем.',
      },
      {
        q: 'Что выгоднее в Таиланде — менять наличные или снимать в банкомате?',
        a: 'Считайте итог, а не котировку. У банкомата фиксированная плата за операцию плюс условия вашего банка, у конторы платы нет, но есть своя маржа. На небольших суммах обычно выигрывает обменник, на крупных — снятие.',
      },
    ],
  },

  'gbp-rub': {
    lead:
      'Чтобы пересчитать британские фунты стерлингов (GBP) в российские рубли (RUB), умножьте сумму в фунтах на текущий курс GBP/RUB — фунт традиционно дороже и доллара, и евро. '
      + 'Пересчитывает фунты приложение {{app}}: бесплатно на Android и iOS, работает и офлайн. Страница разбирает то, на чём здесь спотыкаются чаще всего, — направление котировки и состав итогового счёта.',
    h2: 'Фунт — валюта счетов, а не кошелька',
    body: [
      'У русскоязычного читателя фунт редко оказывается наличными в кармане. Гораздо чаще это валюта выставленного счёта: обучение в британском университете, участие в аукционе, подписка на профессиональный сервис, заказ у британского продавца, юридические и страховые услуги. Суммы крупные и разовые, поэтому цена ошибки в пересчёте выше, чем в курортных парах.',
      'Главная ловушка — направление котировки. Рынок торгует фунт как базовую валюту, GBP/USD, и заголовок в новостях говорит, сколько долларов стоит один фунт, а не наоборот. Прочитанное задом наперёд число делает счёт в разы дешевле, чем он есть, а обнаруживается это уже при оплате.',
      'Вторая деталь — налог. Британские ценники включают НДС, но для покупателя из-за пределов страны итог в корзине может отличаться от витрины: часть продавцов снимает налог при отправке за рубеж, часть нет, зато на принимающей стороне добавятся собственные платежи и доставка. Пересчитывать имеет смысл итоговую строку заказа, а не цену на карточке товара.',
    ],
    tips: {
      h3: 'Заметки по GBP/RUB',
      items: [
        'Фунт делится на 100 пенсов; десятичный счёт ввели в 1971 году, до этого в фунте было 240 пенсов.',
        'Шотландские и североирландские банкноты — тот же фунт и та же котировка, отдельного пересчёта не требуют.',
        'В новостях чаще дают GBP/USD: это доллары за один фунт, а не фунты за доллар.',
        'Пересчитывайте итог заказа вместе с доставкой и сборами, а не цену на витрине.',
      ],
    },
    faq: [
      {
        q: 'Почему в новостях пишут GBP/USD, а не наоборот?',
        a: 'По рыночной традиции фунт стерлингов котируется как базовая валюта, поэтому цифра означает количество долларов за один фунт. Прежде чем считать, проверьте, в какую сторону читается котировка: перепутанное направление меняет сумму счёта в разы.',
      },
      {
        q: 'Шотландские фунты считают по отдельному курсу?',
        a: 'Нет. Банкноты, выпущенные банками Шотландии и Северной Ирландии, — это тот же фунт стерлингов. Пересчёт одинаковый, отличается только рисунок купюры и привычность её для кассира вне Шотландии.',
      },
    ],
  },

  'chf-rub': {
    lead:
      'Пересчёт швейцарских франков (CHF) в российские рубли (RUB) — умножение суммы во франках на текущий курс CHF/RUB; франк входит в число самых дорогих валют мира. '
      + 'Считает франки приложение {{app}} — бесплатно, на Android и iOS, по сохранённым данным даже без сети. Страница объясняет, почему франк ведёт себя не так, как соседние европейские валюты.',
    h2: 'Франк как убежище и как цена поездки',
    body: [
      'Франк попадает в поле зрения по двум разным поводам. Первый бытовой: горнолыжный сезон, лечение, обучение, часы и вообще любые счета из страны, где уровень цен один из самых высоких в Европе. Второй финансовый: франк принято считать валютой-убежищем, и в недели рыночной паники он дорожает практически ко всему, включая евро и доллар.',
      'Репутация тихой гавани не означает предсказуемости. В 2011 году швейцарский регулятор объявил минимальный курс франка к евро и удерживал его массовыми покупками валюты, а в январе 2015-го отменил без предупреждения — за считаные минуты франк подорожал так, что несколько брокеров разорились. История поучительная: даже управляемая величина не является обещанием.',
      'Для поездки важнее приземлённое. Швейцария не входит в еврозону, и хотя во многих туристических местах евро возьмут, сдачу выдадут во франках по внутреннему курсу магазина, который щедрым бывает редко. Тот же франк — официальная валюта Лихтенштейна, так что на две страны нужна одна цифра.',
    ],
    tips: {
      h3: 'Заметки по CHF/RUB',
      items: [
        'Платите во франках: приём евро в Швейцарии — услуга магазина со своими условиями, а не выгода.',
        'Франк делится на 100 раппенов, во французской части — сантимов; монету в 1 раппен изъяли из обращения в 2007 году.',
        'Франк дорожает в моменты рыночной паники — это его многолетняя особенность, а не прогноз.',
        'Графики за пять лет в {{app}} наглядно показывают, как выглядел на этой паре январь 2015 года.',
      ],
    },
    faq: [
      {
        q: 'Можно ли в Швейцарии расплатиться евро?',
        a: 'В туристических магазинах, отелях и на вокзалах — часто да, но условия назначает сам продавец, а сдачу выдаст во франках. Оплата картой во франках почти всегда оказывается ближе к справочной величине.',
      },
      {
        q: 'Почему франк называют валютой-убежищем?',
        a: 'Из-за многолетнего сочетания низкой инфляции, устойчивых государственных финансов и положения страны вне валютных союзов. Когда инвесторы уходят от риска, спрос на франк растёт, поэтому он дорожает именно в плохие для рынков недели.',
      },
    ],
  },

  'jpy-rub': {
    lead:
      'Чтобы пересчитать японские иены (JPY) в российские рубли (RUB), умножьте иеновую сумму на текущий курс JPY/RUB; разменной части у иены нет, поэтому цены выглядят длинными. '
      + 'Пересчёт делает приложение {{app}}: бесплатно на Android и iOS, работает и без интернета. Страница объясняет, откуда берётся такая длина японских цен и что с ней делать.',
    h2: 'Иена, аукционы и машины из Японии',
    body: [
      'У этой пары есть очень конкретная аудитория — Дальний Восток. Автомобили с японских аукционов десятилетиями идут во Владивосток, Уссурийск и дальше по стране, а ставка на торгах выставляется в иенах. Между ставкой и итоговой рублёвой ценой встанут аукционный сбор, внутренняя доставка, фрахт, пошлина и утилизационный сбор, но начинается смета всегда с иеновой суммы, которую надо уметь быстро перевести в понятные деньги.',
      'Вторая аудитория — покупатели с японских торговых площадок: фотоаппараты, инструменты, музыкальные инструменты, коллекционные вещи, запчасти. Здесь пересчёт нужен ежедневно, потому что торги идут в реальном времени и решение принимается за минуты.',
      'Формат цены сбивает с толку сильнее самой котировки. По стандарту ISO 4217 у иены ноль знаков после запятой: сотую долю, сен, вывели из обращения ещё в 1953 году. Поэтому пятизначная цена в Японии — рядовая величина, а не опечатка, а банкнота в десять тысяч иен, самая крупная в обращении, вещь совершенно повседневная.',
    ],
    tips: {
      h3: 'Заметки по JPY/RUB',
      items: [
        'У иены ноль знаков после запятой — результат пересчёта всегда целое число.',
        'Ставка на японском аукционе — только начало сметы: сборы, фрахт и пошлины считаются отдельно.',
        'Сильнее всего иену двигают решения Банка Японии — расписание его заседаний публикуется заранее.',
        'Закрепите JPY/RUB в избранном {{app}}, если следите за торгами каждый день.',
      ],
    },
    faq: [
      {
        q: 'Почему в японских ценах нет копеек?',
        a: 'По стандарту ISO 4217 у иены ноль знаков после запятой: сен, сотая доля иены, ушёл из обращения в 1953 году. Все суммы целые, и цена в несколько тысяч — обычная величина, а не ошибка ввода.',
      },
      {
        q: 'Как перевести ставку с японского аукциона в рубли?',
        a: 'Переведите иеновую ставку по справочной величине, а затем добавьте аукционный сбор, внутреннюю доставку, фрахт, таможенную пошлину и утилизационный сбор. Считаются они по своим правилам и в сумме часто превышают саму ставку.',
      },
    ],
  },

  'krw-rub': {
    lead:
      'Пересчёт южнокорейских вон (KRW) в российские рубли (RUB) даёт число заметно меньше исходного: вона — мелкая по масштабу валюта без разменной части. '
      + 'Пересчитывает воны приложение {{app}} — бесплатно, на Android и iOS, в том числе офлайн. Страница объясняет корейский способ записи сумм, из-за которого чаще всего ошибаются в разряде.',
    h2: 'Вона: корейские заказы и Дальний Восток',
    body: [
      'Эту пару чаще всего открывают покупатели корейской косметики, техники, одежды и музыки: корейские магазины давно освоили отправку за рубеж, а цены на витринах указаны в вонах. Второй устойчивый поток — Дальний Восток: перелёты в Сеул и Пусан, медицинские программы, автозапчасти и подержанные машины из Кореи.',
      'Числовая ловушка тут двойная. Во-первых, по стандарту ISO 4217 у воны ноль знаков после запятой: копеек нет, суммы всегда целые, поэтому даже стакан кофе стоит четырёхзначное число. Во-вторых, корейцы считают крупные суммы десятками тысяч: разряд 만 (ман) равен 10 000 вон, и цена «5만» означает пятьдесят тысяч. Прочитанная буквально, она ошибается ровно в десять тысяч раз.',
      'Отсюда полезная привычка: переводить итог заказа целиком, а не отдельные позиции. Когда в каждой строке по три-четыре нуля, потерять разряд слишком легко, а обнаружить это уже после оплаты доставки — обидно.',
    ],
    tips: {
      h3: 'Заметки по KRW/RUB',
      items: [
        'У воны нет разменной части: чон в наличных расчётах не используется, суммы всегда целые.',
        'Разряд 만 (ман) равен десяти тысячам вон — корейские ценники часто считают именно им.',
        'На корейском сайте выбирайте оплату в вонах: пересчёт магазином в рубли — его собственная конвертация.',
        'Самая крупная банкнота — 50 000 вон, поэтому наличные расчёты выглядят объёмно.',
      ],
    },
    faq: [
      {
        q: 'Что означает знак 만 в корейских ценах?',
        a: 'Это разряд в десять тысяч вон. Запись «3만» читается как тридцать тысяч вон, и переводить нужно уже полученное число. Это способ записи чисел, а не отдельная денежная единица.',
      },
      {
        q: 'Почему корейские цены такие длинные?',
        a: 'Вона не делится на более мелкие единицы, а её масштаб таков, что рядовые покупки выражаются четырёх- и пятизначными числами. Никаких знаков после запятой в корейских ценниках не бывает.',
      },
    ],
  },

  'rub-usd': {
    lead:
      'Пересчёт российских рублей (RUB) в доллары США (USD) — это деление рублёвой суммы на курс USD/RUB, поэтому результат всегда меньше исходного числа. '
      + 'Обе стороны считает приложение {{app}} — бесплатно, на Android и iOS, и без связи тоже. Страница объясняет, почему привычный «курс доллара» в этом направлении применяют наоборот.',
    h2: 'Обратное направление, где чаще всего ошибаются',
    body: [
      'Русскоязычный читатель привык к обороту «курс доллара», то есть к количеству рублей за один доллар. Когда нужно наоборот, из рублей в доллары, включается деление — и именно здесь возникает большинство ошибок: рублёвую сумму по привычке умножают и получают величину на два порядка больше правды. Проверка простая: долларовый результат обязан выйти меньше исходной рублёвой суммы, а не больше.',
      'Само направление требуется постоянно: оценить рублёвый доход или цену квартиры в понятных собеседнику долларах, прикинуть стоимость зарубежной подписки, сравнить предложение о работе, посчитать бюджет переезда или объяснить родственнику за границей, сколько это на самом деле.',
      'Стоит помнить и про сам код валюты. Нынешний RUB появился после деноминации 1 января 1998 года, когда с номиналов убрали три нуля, а прежний код RUR вышел из употребления. Знак ₽ утвердили заметно позже, в конце 2013 года. Поэтому цифры из старых договоров, таблиц и газетных архивов несопоставимы с сегодняшними без поправки на деноминацию.',
    ],
    tips: {
      h3: 'Заметки по RUB/USD',
      items: [
        'Из рублей в доллары считают делением: если умножили, результат завышен в разы.',
        'Код RUB действует с деноминации 1998 года; RUR в старых бумагах — величина в тысячу раз крупнее.',
        'Наличные доллары в банке продают по курсу продажи, а не по официальной величине регулятора.',
        'RUB/USD и USD/RUB — один и тот же рынок с разных сторон; в {{app}} валюты меняются местами одним касанием.',
      ],
    },
    faq: [
      {
        q: 'Рубли в доллары нужно умножать или делить?',
        a: 'Делить. Привычная запись «курс доллара» показывает, сколько рублей стоит один доллар, поэтому рублёвую сумму делят на эту величину. Умножение даёт результат, завышенный на несколько порядков.',
      },
      {
        q: 'Чем код RUB отличается от старого RUR?',
        a: 'RUR обозначал рубль до деноминации 1 января 1998 года, когда номиналы уменьшили в тысячу раз. После неё стандарт ISO 4217 закрепил код RUB. Суммы из документов девяностых нельзя пересчитывать без поправки на деноминацию.',
      },
    ],
  },

  'rub-eur': {
    lead:
      'Пересчёт российских рублей (RUB) в евро (EUR) — это деление рублёвой суммы на курс EUR/RUB, и в евро всегда выходит число меньше исходного. '
      + 'Делает это приложение {{app}}: бесплатно на Android и iOS, считает по сохранённым данным и без связи. Страница о том, что стоит учесть, когда рублёвая сумма превращается в европейскую.',
    h2: 'Сколько это будет в евро',
    body: [
      'Это направление нужно, когда рублёвая сумма должна стать понятной по ту сторону границы: бюджет поездки, стоимость обучения, консульский сбор, помощь родственникам в еврозоне, оценка зарплатного предложения при переезде. Здесь важна не столько точность до цента, сколько порядок величины — во сколько «европейских» денег обходится привычная рублёвая цифра.',
      'Технически евро приходит к рублю через доллар, поэтому итог зависит и от европейской, и от американской стороны. Для разовой прикидки это неважно, а для регулярных платежей — очень: сумма, зафиксированная в договоре в евро, в рублях каждый месяц будет разной, и валютный риск целиком остаётся на плательщике, если в тексте не написано иное.',
      'С наличными евро есть отдельная тонкость. Банкноту в 500 евро перестали выпускать в 2019 году: законным платёжным средством она осталась, но в магазинах её проверяют долго, часть касс отказывается принимать вовсе, а обменные пункты котируют такой номинал хуже мелких. Для перевозки практичнее купюры поменьше.',
    ],
    tips: {
      h3: 'Заметки по RUB/EUR',
      items: [
        'Считайте делением: рублёвую сумму делят на цифру евро, а не умножают на неё.',
        'Банкноту в 500 евро не печатают с 2019 года — принимают её неохотно, меняют по худшим условиям.',
        'Договор в евро означает, что рублёвая нагрузка меняется от платежа к платежу вместе с рынком.',
        'У евро и рубля по два знака после запятой, поэтому округление до цента предсказуемо.',
      ],
    },
    faq: [
      {
        q: 'Почему рублёвый платёж меняется, хотя в договоре сумма зафиксирована?',
        a: 'Зафиксирована сумма в евро, а платите вы рублями. Каждый платёж пересчитывается по величине на день оплаты, поэтому рублёвая нагрузка колеблется, и валютный риск несёт плательщик, если договор не устанавливает иного.',
      },
      {
        q: 'Почему банкноту в 500 евро принимают неохотно?',
        a: 'Её выпуск прекратили в 2019 году. Формально она остаётся законным платёжным средством в еврозоне, но кассиры проверяют её дольше, часть магазинов отказывается брать, а обменные пункты котируют такой номинал хуже мелких.',
      },
    ],
  },
},

  tr: {
  'usd-try': {
    lead:
      'Dolardan liraya çevirmek, tutarı güncel USD/TRY kuruyla çarpmaktır; sonuç girdiğiniz sayıdan çok daha büyük çıkar. '
      + 'Çarpma işini telefonda {{app}} üstlenir; bağlantı kesikken bile sakladığı son kurlarla çalışır. Burada ise o kurun hangi kur olduğunu ayırt edeceksiniz.',
    h2: 'Dolar kurunu Türkiye’de kim, neden takip eder',
    body: [
      '“Dolar ne kadar” sorusu Türkiye’de döviz ticareti yapanların değil, sıradan hanelerin sorusudur. Kira pazarlığından beyaz eşya fiyatına, ikinci el otomobilden yurt dışı uçak biletine kadar pek çok kalem dolara endeksli düşünüldüğü için kur, alışveriş kararının bir parçası haline gelmiştir. Enflasyonun hızlandığı dönemlerde birikimini dövizde tutma alışkanlığı da bu takibi günlük hale getirir.',
      'Asıl kafa karışıklığı kurun kaç olduğunda değil, hangi kur olduğundadır. Bankalar ve TCMB tek bir rakam değil dört rakam yayımlar: döviz alış, döviz satış, efektif alış, efektif satış. “Döviz” hesaptan hesaba giden parayı, “efektif” elinizdeki banknotu tarif eder; banknot taşımanın maliyeti olduğu için efektif tarafı her zaman biraz daha kötüdür. Bankalar arası referans kur ise bunların hiçbirine ait değildir; hepsinin üzerine makas eklendiği çıplak zemindir.',
      'Bir de kuşak farkı var. 1 Ocak 2005’te liradan altı sıfır atıldı ve para birimi “yeni Türk lirası” (YTL) adını aldı; 1 Ocak 2009’da “yeni” ibaresi kaldırılınca ad yeniden “Türk lirası” oldu. ₺ simgesi ise 2012’de belirlendi. Hâlâ “bir milyon” diyerek bir lirayı kasteden bir konuşmayla karşılaşırsanız, aradaki fark bir milyon katıdır.',
    ],
    tips: {
      h3: 'USD/TRY için pratik notlar',
      items: [
        'Döviz bürosunun tabelasındaki alış ile satış arasındaki fark, işlemin asıl bedelidir; tek bir rakama bakıp karar vermeyin.',
        'Efektif (banknot) kuru ile döviz (hesap) kuru aynı bankada bile ayrı yazılır.',
        'Kart ile yapılan dolarlı harcamada kur, alışveriş günü değil işlemin hesaba düştüğü gün belirlenir.',
        'Havalimanı ve otel bürolarının makası şehir içindekilere göre belirgin biçimde geniştir.',
        'Çifti {{app}} içinde favorilere alırsanız uygulama her açılışta onu ilk sırada gösterir.',
      ],
    },
    faq: [
      {
        q: 'Efektif kur ile döviz kuru arasındaki fark nedir?',
        a: 'Efektif kur banknot işlemleri için, döviz kuru ise hesaplar arası transferler için geçerlidir. Banknotun taşınması, saklanması ve sayılması maliyet doğurduğu için efektif tarafta size uygulanan kur genellikle daha kötüdür.',
      },
      {
        q: 'Döviz bürosunun verdiği rakam neden referans kurdan farklı?',
        a: 'Büro kendi alış ve satış makasını referans kurun üzerine ekler; ayrıca nakit stok maliyeti, konum ve saat de bu makası etkiler. {{app}} bankalar arası gösterge kuru gösterir, yani büronun tabelasını ölçeceğiniz zemini.',
      },
    ],
  },

  'eur-try': {
    lead:
      'Euro’dan liraya çeviri, Türkiye’ye gelen paranın en kalabalık yolunu tarif eder: Almanya hattını. '
      + 'Hesabı {{app}} yapar — Almanya yolunda, dolaşım kapalıyken bile. Yazının konusu ise havalenin faturaya yazılmayan maliyetidir.',
    h2: 'Gurbetçi hattı: Almanya, Avrupa ve euro',
    body: [
      'Almanya’da Türkiye kökenli milyonlarca insan yaşıyor ve EUR/TRY onların hem tasarruf hem de aile bütçesi kurudur. Ailelere gönderilen aylık destek, Türkiye’de sürdürülen bir konut kredisi, memlekette yapılan bir inşaat ya da yaz için ayrılan tatil bütçesi aynı sayıya bakar. Avusturya, Hollanda, Belçika ve Fransa’daki topluluklar için de tablo aynıdır; euro ortak para birimi olduğu için hepsinde tek ve aynı kur geçerlidir.',
      'Havale yaparken en sık yapılan hata, sadece komisyona bakmaktır. Bir transferin gerçek bedeli, kuruma uygulanan kur ile bankalar arası referans arasındaki farktır; komisyon sıfır yazan bir hizmet bu farkı geniş tutarak aynı parayı fazlasıyla alabilir. Karşılaştırmanın tek dürüst yolu, iki teklifin sonunda hesaba geçen lira tutarını yan yana koymaktır.',
      'Nakit tarafında da bir alışkanlık var: yaz aylarında araçla Kapıkule üzerinden gelenler euro banknotunu yolda ya da sınırda bozduruyor. Sınır ve otoyol büroları, şehir merkezindeki bürolara göre çoğu zaman daha dar bir teklif verir.',
    ],
    tips: {
      h3: 'EUR/TRY için pratik notlar',
      items: [
        'Havalede asıl maliyet komisyon değil, uygulanan kur ile referans kur arasındaki farktır.',
        'Euro bölgesindeki bütün ülkelerde tek bir kur geçerlidir; Almanya ile Hollanda arasında ayrı hesap yoktur.',
        'Sınır kapısında ya da yol üstünde bozdurulan nakit, genellikle şehir içindeki bürodan daha pahalıya gelir.',
        'Türkiye’deki bir hesaba euro olarak gönderip burada bozdurmakla, gönderirken bozdurmak farklı sonuç verir; ikisini de hesaplayın.',
        'Yolculuk boyunca {{app}} çevrimdışı çalıştığı için mola verdiğiniz her ülkede hesap yapabilirsiniz.',
      ],
    },
    faq: [
      {
        q: 'Almanya’dan Türkiye’ye para gönderirken hangi kuru esas almalıyım?',
        a: 'Gönderim kurumunun size gösterdiği kuru, {{app}} içindeki bankalar arası referansla karşılaştırın. Aradaki fark artı sabit ücret, transferin gerçek maliyetidir; sadece “komisyon yok” ifadesine bakmak yanıltıcıdır.',
      },
      {
        q: 'Euro bölgesindeki her ülkede aynı kur mu geçerli?',
        a: 'Evet. Euro ortak para birimidir, dolayısıyla Almanya, Fransa, İtalya veya Yunanistan’da harcadığınız euro aynı EUR/TRY kuruyla hesaplanır. Ülkeye göre değişen şey kur değil, fiyat seviyesi ve KDV oranıdır.',
      },
    ],
  },

  'gbp-try': {
    lead:
      'Sterlinden liraya çeviri iki ayrı kitlenin işidir: Londra’daki Türkçe konuşan topluluk ve Kuzey Kıbrıs’ta sterlinle konuşulan kalemler. '
      + '{{app}} bu çifti telefonda, bağlantı olmadan da hesaplar.',
    h2: 'Londra ve Kuzey Kıbrıs arasındaki sterlin',
    body: [
      'Birleşik Krallık’ta Türkiye ve Kıbrıs kökenli yüz binlerce kişi yaşıyor; Kuzey Londra’nın Haringey ve Enfield çevresindeki esnaf hattı bunun en görünür yüzü. Bu topluluk için sterlin, Türkiye’ye gönderilen aile desteğinin ve yaz tatili bütçesinin ölçüsü. Buna İngiliz üniversitelerinde okuyan Türkiye’den öğrenciler ekleniyor: harç taksitleri sterlin cinsindendir, her taksit ödendiği günün kuruyla liraya dönüşür ve yıllık bütçe bu yüzden tek bir kurla planlanamaz.',
      'Kuzey Kıbrıs ise başlı başına bir durum. Adanın kuzeyinde günlük hayat Türk lirasıyla dönerken kira, üniversite ücreti, ikinci el araç ve emlak ilanları çoğu zaman sterlin üzerinden konuşulur. Lirayla maaş alıp sterline endeksli kira ödeyen bir hane için GBP/TRY, ayın en önemli sayısıdır.',
      'Bir de okuma yönü tuzağı var: piyasa sterlini taban para birimi olarak kote eder, yani haberlerde gördüğünüz rakam çoğunlukla bir sterlinin kaç dolar ettiğini söyler, liraya dair bir şey söylemez.',
    ],
    tips: {
      h3: 'GBP/TRY için pratik notlar',
      items: [
        'Kuzey Kıbrıs’ta ödeme lirayla yapılsa bile kira ve okul ücreti sterlin üzerinden sözleşmeye bağlanabilir; sözleşmenin para birimini kontrol edin.',
        'İskoçya ve Kuzey İrlanda bankalarının bastığı banknotlar aynı sterlindir; ayrı bir kuru yoktur.',
        'Birleşik Krallık’ta etiket fiyatına KDV dahildir, dolayısıyla çevirdiğiniz tutar kasada ödeyeceğiniz tutardır.',
        'Üniversite harcını taksitle ödüyorsanız her taksit ayrı bir kurla liraya döner; tek kurla yıllık bütçe kurmayın.',
        'Kart terminalleri sterlin yerine lira ile ödeme teklif ederse reddedin; o çeviriyi satıcı tarafı yapar.',
      ],
    },
    faq: [
      {
        q: 'Kuzey Kıbrıs’ta hangi para birimi geçerli?',
        a: 'Kuzey Kıbrıs’ta kullanılan para birimi Türk lirasıdır. Sterlin ve euro bazı işletmelerde kabul edilse de para üstü lira olarak verilir ve kabul kuru işletmenin kendi belirlediği kurdur.',
      },
      {
        q: 'Haberlerde neden GBP/USD yazıyor da GBP/TRY yazmıyor?',
        a: 'Piyasa geleneğinde sterlin taban para birimidir ve en çok işlem gören kotasyonu dolara karşıdır. Liraya karşı sterlin, çoğunlukla bu kotasyon ile dolar-lira üzerinden çapraz hesaplanır.',
      },
    ],
  },

  'chf-try': {
    lead:
      'İsviçre frangı, piyasalar gerildiğinde talep gören klasik güvenli limandır; CHF/TRY bu yüzden dünya risk iştahına duyarlıdır. '
      + 'Rakamı çıkaran {{app}}, çevrimdışıyken en son indirdiği kurları kullanır. Metnin geri kalanı frangın neden ayrı bir karakteri olduğunu anlatıyor.',
    h2: 'Frank neden ayrı bir başlık',
    body: [
      'İsviçre’de yaşayan Türkiye kökenli topluluk, Zürih ve Basel çevresindeki çalışanlar ve İsviçre merkezli şirketlerde görev yapan profesyoneller için frank maaş para birimidir. Türkiye tarafında ise frank, saat, ilaç ve hassas makine ithalatının faturasında karşımıza çıkar. Her iki durumda da CHF/TRY, tek seferlik bir merak değil düzenli bir hesap kalemidir.',
      'Frangın karakteri diğer majörlerden farklıdır. Belirsizlik arttığında sermaye İsviçre’ye kaydığı için frank, kötü haber akışında değer kazanma eğilimindedir; bu da onu Türkiye’deki tasarruf sahibinin gözünde dolar ve euro dışında üçüncü bir seçenek yapar.',
      'Sabit kur sözünün ne kadar kalıcı olduğuna dair en iyi ders de bu para biriminde saklı: İsviçre Ulusal Bankası, 2011’de ilan edip euroya karşı savunduğu alt sınırı 2015 Ocak’ında bir sabah bırakınca frank dakikalar içinde sıçradı ve o sınıra güvenerek pozisyon almış herkes aynı gün sonuçla yüzleşti. Bir kurun “sabit” olması, sonsuza kadar sabit kalacağı anlamına gelmez.',
    ],
    tips: {
      h3: 'CHF/TRY için pratik notlar',
      items: [
        'İsviçre’de dolaşımdaki en küçük madeni para 5 rapendir; nakit toplamlar 5’in katına yuvarlanır.',
        'Frank, Liechtenstein’da da resmî para birimi olarak kullanılır.',
        'İsviçre’de fiyat seviyesi Avrupa ortalamasının belirgin üzerindedir; bütçeyi etiketten değil günlük toplamdan çıkarın.',
        'Frank haber akışına tepki verdiği için hafta içi gün içinde bile fark edilir hareket görebilir.',
        '{{app}} bu çifti 5 yıla kadar grafiğe döker; bugünkü seviyenin olağan mı olağandışı mı olduğunu böyle görürsünüz.',
      ],
    },
    faq: [
      {
        q: 'İsviçre frangı neden güvenli liman sayılıyor?',
        a: 'Uzun süredir düşük enflasyon, güçlü dış fazla ve istikrarlı bir hukuk düzeni frangı belirsizlik dönemlerinde tercih edilen bir sığınak haline getirdi. Kriz haberlerinde franga talep artar, bu da değerini yukarı iter.',
      },
      {
        q: 'Merkez bankasının ilan ettiği bir sınır sonsuza kadar sürer mi?',
        a: 'Hayır. İsviçre Ulusal Bankası 2015 Ocak’ında euroya karşı savunduğu alt sınırı önceden haber vermeden bıraktı ve frank aynı gün sert biçimde değerlendi. Politika kararları değişebilir, bu yüzden kura her işlemden önce yeniden bakmak gerekir.',
      },
    ],
  },

  'sar-try': {
    lead:
      'Suudi Arabistan riyali 1986’dan bu yana dolara sabitlendiği için SAR/TRY hareketi neredeyse tamamen dolar-lira tarafından gelir. '
      + 'Umre yolunda bağlantı olmasa bile riyal hesabını {{app}} yapar. Buradaki metin, sabit oranın üstüne eklenen makası konu ediyor.',
    h2: 'Umre, hac ve Körfez’de çalışanlar',
    body: [
      'Türkiye’den Suudi Arabistan’a giden trafiğin büyük bölümü umre ve hac yolculuklarıdır; buna Riyad ve Cidde’de çalışan mühendisler, müteahhitlik firmalarının personeli ve ihracatçılar eklenir. Bu kitle için riyal, bir yatırım aracı değil bir harcama bütçesidir: konaklama, ulaşım, hediyelik ve kurban bedeli riyal cinsinden konuşulur.',
      'Sabit kurun anlamı burada çok pratiktir. Riyalin dolara bağlı oranı yıllardır yerinde durduğu için SAR/TRY grafiğine bakmak, aslında USD/TRY grafiğine bakmakla hemen hemen aynı şeydir. Yolculuk bütçeniz riyal cinsinden olsa bile onu asıl belirleyen sayı dolar-lira kurudur.',
      'Gerçek maliyet ise sabit oranın üzerine eklenen makastadır. Türkiye’deki bürolarda riyal banknotu dolara göre daha az bulunur; az bulunan banknotta makas genişler. Üstelik lirayı önce dolara, sonra riyale çeviren bir yol izlerseniz makası iki kez ödersiniz.',
    ],
    tips: {
      h3: 'SAR/TRY için pratik notlar',
      items: [
        'Riyalin alt birimi halaladır; yüz halala bir riyal eder.',
        'Sabit oran nedeniyle bütçenizi asıl belirleyen sayı dolar-lira kurudur, riyalin kendisi değil.',
        'Suudi Arabistan’da kart kabulü yaygındır; nakdi ihtiyaç duyduğunuz kadar bozdurmak makas maliyetini düşürür.',
        'Türkiye’de riyal banknotu her büroda bulunmaz; bulunduğunda makas dolara göre geniş olur.',
        'Umre paketlerinde bazı kalemler lira, bazıları riyal cinsinden fiyatlanır; toplamı tek para biriminde toplayın.',
      ],
    },
    faq: [
      {
        q: 'SAR/TRY kuru neden dolar kuruyla birlikte hareket ediyor?',
        a: 'Riyal 1986’dan beri dolara sabit bir oranla bağlıdır. Bu oran değişmediği sürece riyalin lira karşısındaki değeri, doların lira karşısındaki değerinin bir yansımasıdır.',
      },
      {
        q: 'Umre için nakit riyal mi taşımalıyım, kart mı kullanmalıyım?',
        a: 'İkisini birlikte kullanmak genellikle en ucuzudur. Kart ödemesinde riyal cinsinden ödemeyi seçin, nakdi de küçük harcamalar için ihtiyacınız kadar bozdurun; büyük miktarda banknot taşımak hem makas hem risk demektir.',
      },
    ],
  },

  'aed-try': {
    lead:
      'Birleşik Arap Emirlikleri dirhemi 1997’den bu yana dolara sabit bir kurla bağlıdır, dolayısıyla AED/TRY’deki oynaklık lira tarafından gelir. '
      + '{{app}} bu hesabı Dubai’de bağlantınız olmasa da yapar.',
    h2: 'Dubai: tatil, ticaret ve altın',
    body: [
      'Dubai, Türkiye’den bakınca üç ayrı sebeple ziyaret edilir: tatil, fuar ve ticaret. Türk firmaları için Emirlikler bir yeniden ihracat merkezidir; tekstil, mobilya, gıda ve makine Körfez ile Afrika pazarlarına buradan dağılır. Turist tarafında ise alışveriş merkezleri, altın çarşısı ve otel harcamaları dirhem cinsinden bir bütçe gerektirir.',
      'Dirhemin dolara sabit olması, tatil planı yapan biri için şu anlama gelir: bugün baktığınız AED/TRY ile üç ay sonra bakacağınız arasındaki fark, dirhemin değil liranın hareketidir. Grafiği takip ederken dirhemi değil, dolar-lira tarafını izlemek daha doğru bir alışkanlıktır.',
      'Fiyat okurken iki kalem sürpriz yaratır. Emirlikler’de katma değer vergisi 2018’de yürürlüğe girdi ve turistler için iade sistemi var; ayrıca otel faturasına gecelik turizm harcı ile hizmet bedeli eklenir. Yani rezervasyon ekranında gördüğünüz dirhem tutarı çoğu zaman ödeyeceğiniz son tutar değildir.',
    ],
    tips: {
      h3: 'AED/TRY için pratik notlar',
      items: [
        'Dirhemin alt birimi filstir; yüz fils bir dirhem eder.',
        'Otel fiyatına gecelik turizm harcı ve hizmet bedeli eklenir; etiket toplam değildir.',
        'Turistler için katma değer vergisi iadesi mümkündür, ancak nakit alışverişte belgeyi kasada istemeniz gerekir.',
        'Lirayı önce dolara sonra dirheme çevirmek makası iki kez ödettirir; tek adımda çevirmeye bakın.',
        'Altın çarşısında fiyat gram ve işçilik üzerinden konuşulur; toplamı dirhem olarak alıp tek seferde çevirin.',
      ],
    },
    faq: [
      {
        q: 'Dubai’ye giderken lirayı dirheme mi, dolara mı çevirmeliyim?',
        a: 'Dirhem dolara sabit olduğu için iki yol da aynı yere çıkar, ama iki ayrı çeviri iki ayrı makas demektir. Tek adımda dirhem elde edebiliyorsanız genellikle daha az kaybedersiniz.',
      },
      {
        q: 'Dirhem kuru neden neredeyse hiç değişmiyor?',
        a: 'Emirlikler Merkez Bankası dirhemi 1997’den beri dolara sabit bir oranda tutuyor. Bu yüzden dirhemin dolara karşı grafiği düz bir çizgidir; lira karşısındaki değişim ise tamamen liranın kendi hareketidir.',
      },
    ],
  },

  'rub-try': {
    lead:
      'Ruble ile lira arasında derin bir doğrudan piyasa olmadığı için RUB/TRY kuru çoğunlukla dolar üzerinden çapraz hesaplanır. '
      + 'Çapraz kurun sonucunu {{app}} bağlantısızken de verir. Devamında, Antalya hattında kurumdan kuruma neden farklı teklif çıktığı var.',
    h2: 'Antalya hattı: turist, yerleşik ve ihracat',
    body: [
      'Rusya’dan gelen ziyaretçiler yıllardır Türkiye’nin en kalabalık turist gruplarından biri; Antalya, Alanya ve Kemer bölgesinde bu trafik sezonluk olmaktan çıkıp yerleşik bir topluluğa dönüştü. Konut satın alan, çocuğunu buradaki okula yazdıran ve kirasını lirayla ödeyen ama gelirini rubleyle alan haneler için RUB/TRY aylık bir hesap kalemidir.',
      'Ters yönde de bir akış var: Türkiye’den Rusya’ya giden yaş sebze meyve, tekstil ve müteahhitlik hizmetleri. Bu ticarette fiyatlar çoğunlukla dolar ya da euro üzerinden bağlanır, ancak nihai satış rubleyle yapıldığı için aradaki kur farkı doğrudan kâr marjına yansır.',
      'Pratik tarafta iki ayrıntı önemli. Birincisi, rublenin lira karşısındaki kotasyonu bankadan bankaya belirgin farklılık gösterir; işlem hacmi ince olduğu için makas dolar ve euroya kıyasla geniştir. İkincisi, kart altyapılarındaki kısıtlar nedeniyle Rusya’da verilmiş kartların Türkiye’de çalışması sınırlıdır, bu da nakit planlamasını yeniden önemli hale getirmiştir.',
    ],
    tips: {
      h3: 'RUB/TRY için pratik notlar',
      items: [
        'Ruble-lira kuru genellikle doğrudan değil, dolar üzerinden çapraz olarak oluşur.',
        'Antalya ve Alanya’da ruble kabul eden bürolar vardır, ancak makas dolar ve euroya göre geniştir.',
        'Rublenin alt birimi kopektir; günlük hayatta pratik olarak kullanılmaz.',
        'Kart kabulündeki kısıtlar nedeniyle nakit ihtiyacını önceden planlamak gerekir.',
        'İhracat faturası dolar cinsindense, ruble tahsilatı ile lira maliyeti arasında iki ayrı kur riski taşırsınız.',
      ],
    },
    faq: [
      {
        q: 'Antalya’da ruble bozdurabilir miyim?',
        a: 'Turizm bölgelerindeki birçok büro ruble kabul eder, ancak uygulanan makas dolar veya euroya göre daha geniştir. Bozdurmadan önce {{app}} içindeki referans kurla kıyaslamak, farkın büyüklüğünü görmenin en hızlı yoludur.',
      },
      {
        q: 'RUB/TRY kuru neden kurumdan kuruma bu kadar değişiyor?',
        a: 'İki para birimi arasındaki doğrudan işlem hacmi görece incedir ve kurumlar fiyatı dolar üzerinden çapraz kurarak oluşturur. Zincirdeki her adım kendi makasını eklediği için nihai teklifler birbirinden belirgin biçimde ayrışır.',
      },
    ],
  },

  'jpy-try': {
    lead:
      'Japon yeninin dolaşımda alt birimi yoktur, bu yüzden yen fiyatları tam sayıdır ve dört ya da beş basamaklı bir menü fiyatı Japonya’da olağandır. '
      + '{{app}} bu çevirileri bağlantısız da yapar.',
    h2: 'Yende yüz birimlik kotasyon tuzağı',
    body: [
      'Türkiye’de yen çevirisinin en sık yapılan hatası kur tablosunu yanlış okumaktır. Merkez bankasının ve pek çok bankanın kur listesinde yen tek birim üzerinden değil, yüz birim üzerinden yazılır; yani satırdaki rakam bir yenin değil yüz yenin lira karşılığıdır. Bunu fark etmeden hesap yapan biri, Japonya’daki her fiyatı yüz katı pahalı sanır.',
      'İkinci tuzak basamak sayısıdır. Yenin kuruş karşılığı bir alt birimi tedavülde bulunmadığı için tutarlar virgülsüz yazılır; bir kahve fiyatının dört basamaklı görünmesi normaldir, yanlış girilmiş bir rakam değildir.',
      'Bu çifti kimler kullanır? Japonya’ya seyahat eden gezginler, Japon otomotiv ve makine parçası ithal eden firmalar, kamera ve müzik aleti gibi ürünleri doğrudan Japonya’dan satın alanlar ve Türkiye’ye gelen Japon ziyaretçilere hizmet veren işletmeler. Yenin uzun yıllar boyunca düşük faiz ortamında kalması, çiftin geçmiş seyrini de belirgin biçimde şekillendirmiştir.',
    ],
    tips: {
      h3: 'JPY/TRY için pratik notlar',
      items: [
        'Banka kur tablolarında yen çoğunlukla yüz birim üzerinden yazılır; karşılaştırmadan önce hangi birime baktığınızı kontrol edin.',
        'Yenin dolaşımda alt birimi olmadığı için çevrilen tutarlar tam sayıdır.',
        'Japonya’da nakit hâlâ yaygındır; market zincirlerinin ATM’leri yabancı kartlarda en güvenilir seçenektir.',
        'Ziyaretçilere yapılan vergisiz satış, kasada yen üzerinden işlenir; çeviri ondan sonra gelir.',
        'Metro ve yeraltı geçitlerinde bağlantı kopabildiği için çevrimdışı çeviri burada gerçekten işe yarar.',
      ],
    },
    faq: [
      {
        q: 'Kur tablosunda neden “100 JPY” yazıyor?',
        a: 'Yenin birim değeri çok küçük olduğu için kur listelerinde yüz birim üzerinden kote edilmesi yerleşmiş bir uygulamadır. Tabloda gördüğünüz rakamı bir yenin karşılığı sanmak, hesabınızı yüz kat şişirir.',
      },
      {
        q: 'Japonya’daki fiyatlar neden bu kadar uzun görünüyor?',
        a: 'Yenin ISO 4217 alt birim üssü sıfırdır, yani dolaşımda kuruşu yoktur. Günlük harcamalar bu nedenle dört ve beş basamaklı tam sayılarla yazılır; ondalık basamak hiç kullanılmaz.',
      },
    ],
  },

  'cad-try': {
    lead:
      'Kanada doları ile ABD doları aynı işareti paylaşır, bu yüzden CAD/TRY çevirisinde ilk iş fiyatın hangi dolar olduğunu doğrulamaktır. '
      + 'Doğru doları seçtikten sonra sonucu {{app}} çıkarır, bağlantı yokken de. Kalan kısım göç, öğrenci bütçesi ve petrol bağını anlatıyor.',
    h2: 'Göç, öğrenci ve petrole bağlı bir dolar',
    body: [
      'Kanada, Türkiye’den giden öğrenci ve nitelikli göçmen için son yılların en çok konuşulan adreslerinden biri. Başvuru aşamasında okul ücreti, yaşam gideri beyanı ve blokeli hesap gibi kalemlerin hepsi Kanada doları cinsinden istenir; başvuru sahibi ise birikimini lirada tutar. Bu yüzden CAD/TRY, başvurunun tarihini bile etkileyebilen bir sayıya dönüşür.',
      'Toronto, Montreal ve Vancouver’daki Türkiye kökenli topluluk için çift ters yönde de işler: Türkiye’deki aileye gönderilen destek ya da burada sürdürülen bir kira ödemesi aynı kurdan geçer.',
      'Fiyat okurken Türkiye’den gelen alışkanlık yanıltır. Türkiye’de etiket fiyatına KDV dahildir; Kanada’da ise satış vergisi kasada eklenir ve eyalete göre değişir, dolayısıyla rafta gördüğünüz tutarı çevirmek eksik hesap verir. Kanada dolarının bir de emtia yönü vardır: enerji ihracatı ekonomide büyük yer tuttuğu için petrol fiyatındaki hareket bu para birimine sık sık yansır.',
    ],
    tips: {
      h3: 'CAD/TRY için pratik notlar',
      items: [
        'Kanada’da etiket fiyatına satış vergisi dahil değildir; kasada eyalete göre eklenir.',
        'Bir sentlik madeni para 2013’te tedavülden kaldırıldı; nakit ödemelerde toplam beş sentin katına yuvarlanır.',
        'CA$ ve US$ ayrımına dikkat edin; ilan ve fatura üzerinde ISO kodunu aramak en güvenli yoldur.',
        'Kanada doları enerji fiyatlarına duyarlıdır, bu yüzden bazen iki merkez bankasının kararlarından bağımsız hareket eder.',
        'Blokeli hesap ve harç gibi büyük kalemleri tek seferde değil, kur seyrine bakarak parça parça çevirmek yaygın bir yöntemdir.',
      ],
    },
    faq: [
      {
        q: 'Kanada’da etiket fiyatı ödeyeceğim tutar mı?',
        a: 'Hayır. Satış vergisi kasada eklenir ve eyaletten eyalete değişir. Türkiye’deki alışkanlığın aksine, çevirmeniz gereken rakam raftaki değil ödeme ekranındaki toplamdır.',
      },
      {
        q: 'Kanada doları neden petrol fiyatıyla birlikte hareket ediyor?',
        a: 'Enerji, Kanada ihracatının önemli bir bölümünü oluşturur; ham petrole talep arttığında bu para birimine talep de artma eğilimindedir. Bu bir kural değil eğilimdir ve faiz kararlarıyla tersine dönebilir.',
      },
    ],
  },

  'aud-try': {
    lead:
      'Avustralya doları emtia fiyatlarına ve Asya talebine bağlı hareket eder, bu yüzden AUD/TRY iki ülkenin iç gündeminden bağımsız günler yaşar. '
      + '{{app}} çifti çevrimdışı da hesaplar.',
    h2: 'Melbourne, Sidney ve Çanakkale hattı',
    body: [
      'Avustralya’daki Türkiye kökenli topluluk ağırlıklı olarak Melbourne ve Sidney çevresinde yerleşiktir ve elli yılı aşan bir göç geçmişine sahiptir. Bu hane halkları için AUD/TRY, Türkiye’ye gönderilen destek ile buradaki tatil ve düğün masraflarının ortak ölçüsüdür. Buna çalışma tatili vizesiyle bir yıllığına gidenler ve Avustralya üniversitelerinde okuyan öğrenciler eklenir.',
      'Ters yönde Çanakkale var. Her yıl 25 Nisan’da Gelibolu’ya gelen Avustralyalı ziyaretçiler için Türkiye bir anma takvimi kadar bir seyahat bütçesidir; bölgedeki konaklama ve tur işletmeleri bu tarih etrafında Avustralya dolarıyla düşünmeye alışkındır.',
      'Para biriminin kendisi de iki ayrıntıyla anılır: Avustralya, banknotlarını polimer malzemeye geçiren ilk ülke oldu ve bu notlar hâlâ dolaşımda. Fiyat tarafında ise mal ve hizmet vergisi etikete dahildir; yani gördüğünüz tutarı çevirdiğinizde ödeyeceğiniz tutarı bulursunuz. Bahşiş de zorunlu bir alışkanlık değildir, hesap toplamına ekleme yapmanız beklenmez.',
    ],
    tips: {
      h3: 'AUD/TRY için pratik notlar',
      items: [
        'Avustralya’da etiket fiyatına mal ve hizmet vergisi dahildir; çevirdiğiniz tutar ödeyeceğiniz tutardır.',
        'Bahşiş yerleşik bir kural değildir; restoran hesabına kendiliğinden ekleme yapmanız gerekmez.',
        'Avustralya banknotları polimerdir; ıslandığında zarar görmez ama katlandığında kart yuvalarında sorun çıkarabilir.',
        'Bu para birimi demir cevheri ve Asya talebiyle hareket ettiği için emtia haberleri kurda iz bırakır.',
        'Ülke içinde uzun mesafelerde kapsama alanı kesilir; çevrimdışı çeviri burada gerçek bir ihtiyaçtır.',
      ],
    },
    faq: [
      {
        q: 'Avustralya’da fiyatlara vergi dahil mi?',
        a: 'Evet. Mal ve hizmet vergisi etiket fiyatının içindedir, dolayısıyla çevirdiğiniz rakam kasada ödeyeceğiniz rakamla aynıdır. Bu yönüyle Türkiye’deki fiyat gösterimine benzer.',
      },
      {
        q: 'Avustralya doları neden emtia para birimi sayılıyor?',
        a: 'İhracatın büyük bölümü ham madde olduğu için bu ürünlere gelen talep, para birimine gelen talebi de sürükler. Sonuç olarak kur, yurt içi ekonomik verilerden çok küresel emtia fiyatlarına tepki verebilir.',
      },
    ],
  },

  'qar-try': {
    lead:
      'Katar riyali 2001’den bu yana dolara sabit bir kurla bağlıdır, dolayısıyla QAR/TRY grafiğindeki hareketin tamamına yakını lira kaynaklıdır. '
      + 'Doha aktarmasında bağlantı yokken bile riyal karşılığını {{app}} çıkarır. Yazının odağı, maaşı riyal olup ailesi lira harcayan hanelerdir.',
    h2: 'Doha’da çalışmak, Doha’dan geçmek',
    body: [
      'Katar, Türk müteahhitlik firmalarının uzun süredir iş aldığı bir pazar; stadyum, metro, havalimanı ve konut projelerinde çalışan Türkiyeli mühendis ve teknik personel maaşını riyal olarak alır, ailesine ise lira gönderir. Bu düzenli akış, QAR/TRY’yi tatil kuru değil maaş kuru yapar.',
      'İkinci kitle transit yolculardır. Doha, Uzak Doğu ve Afrika bağlantılarında büyük bir aktarma noktası olduğu için Türkiye’den geçen yolcuların bir kısmı ülkeye hiç girmeden birkaç saatliğine riyal harcar. Havalimanı içinde bozdurulan küçük tutarlarda makas oransal olarak en yüksek yerdedir.',
      'İsim benzerliği ayrı bir dikkat konusu. Katar riyalinin alt birimi “dirhem” olarak adlandırılır; Birleşik Arap Emirlikleri’nde ise dirhem para biriminin kendisidir. Aynı kelimenin bir ülkede kuruş, diğerinde lira karşılığı olması, Körfez’de iki ülkeyi birlikte gezenlerde hesap hatasına yol açar.',
    ],
    tips: {
      h3: 'QAR/TRY için pratik notlar',
      items: [
        'Katar riyalinin alt birimi dirhemdir; yüz dirhem bir riyal eder ve bu Emirlikler’in para birimiyle aynı şey değildir.',
        'Sabit oran nedeniyle riyal bütçenizin lira karşılığını belirleyen asıl sayı dolar-lira kurudur.',
        'Aktarmada havalimanı içinde bozdurulan küçük tutarlarda makas oransal olarak en yüksektir.',
        'Doha’dan gönderilen maaşta asıl maliyet transfer ücreti değil, uygulanan kur farkıdır.',
        'Türkiye’de riyal banknotu sınırlı sayıda büroda bulunur; peşin arama yapmadan yola çıkmayın.',
      ],
    },
    faq: [
      {
        q: 'Katar riyali ile Emirlikler dirhemi aynı şey mi?',
        a: 'Hayır. İkisi ayrı para birimidir ve ayrı ISO kodları vardır. Karışıklık, Katar riyalinin yüzde birlik alt biriminin de “dirhem” diye anılmasından kaynaklanır.',
      },
      {
        q: 'Doha’dan Türkiye’ye para gönderirken hangi kur geçerli olur?',
        a: 'Transferi yapan kurumun kendi kuru geçerli olur. {{app}} içindeki referans kur o teklifi ölçmek içindir: aradaki fark artı sabit ücret, gönderimin toplam maliyetini verir.',
      },
    ],
  },

  'try-usd': {
    lead:
      'Liradan dolara çeviri alıştığınız yönün tersidir: sonuç girdiğiniz tutardan küçük, virgülden sonra başlayan bir sayı olur. '
      + 'Ters yönü de {{app}} hesaplar, çevrimdışıyken dahi. Metin, lirayı dolara çevirmenin kimin günlük işi olduğunu anlatıyor.',
    h2: 'Lirayı dolara çevirmek kimin işi',
    body: [
      'Bu yön, kazancı lira olup gideri ya da hedefi dolar olanların yönüdür. Yurt dışındaki müşteriye hizmet veren yazılımcılar, tasarımcılar ve çevirmenler; uluslararası pazar yerlerinde satış yapan küçük üreticiler; yurt dışı eğitim ya da seyahat için bütçe ayıran haneler aynı hesabı yapar.',
      'Serbest çalışan için kritik ayrıntı zamanlamadır. Fiyat bugün konuşulur, tahsilat haftalar sonra gerçekleşir ve fatura tutarının lira karşılığı ödeme gününün kuruyla belirlenir. Sözleşmede bir kur maddesi yoksa, sabit fiyatlı bir iş farkında olmadan bir kur pozisyonuna dönüşür.',
      'Bir de yasal çerçeve var: 2018’den bu yana Türkiye’de yerleşik kişiler arasındaki konut ve iş yeri alım-satım ile kira sözleşmelerinin bedeli lira üzerinden belirlenir. Yani yurt içindeki kira ve satış pazarlığını dolara bağlamak artık genel bir uygulama değildir; dolar hesabı çoğunlukla yurt dışına dönük gelir ve harcamalar için yapılır.',
    ],
    tips: {
      h3: 'TRY/USD için pratik notlar',
      items: [
        'Yurt dışı müşteriye kesilen faturada lira karşılığı, tahsilat gününün kuruyla belirlenir; sözleşme günüyle değil.',
        'Sonuç virgülden sonra başladığı için ondalık hassasiyetini artırmak, küçük tutarlarda okumayı kolaylaştırır.',
        'Türkiye’de yerleşikler arasındaki konut ve iş yeri kira sözleşmeleri lira üzerinden yapılır.',
        'Gelen dövizi bozdurma zamanlaması, çoğu serbest çalışan için fiyat pazarlığı kadar belirleyicidir.',
        'Uzun vadeli bir işte sözleşmeye kur maddesi koymak, riski tek tarafta bırakmamanın en basit yoludur.',
      ],
    },
    faq: [
      {
        q: 'Yurt dışına verdiğim hizmeti dolarla mı, lirayla mı faturalamalıyım?',
        a: 'Dolarla faturalarsanız kur riski sizde kalır ve tahsilat gününe kadar tutarın lira karşılığı değişir. Lirayla faturalarsanız risk müşteriye geçer, ancak fiyatınız yurt dışında karşılaştırması zor bir rakama dönüşür.',
      },
      {
        q: 'TRY/USD sonucu neden virgülden sonra çıkıyor?',
        a: 'Çünkü bir liranın dolar karşılığı birden küçüktür. Türkiye’de kur alışkanlığı “bir dolar kaç lira” yönünde olduğu için ters yön ilk bakışta yanlış görünür; aslında aynı kurun tersidir.',
      },
    ],
  },
},

  pl: {
  'eur-pln': {
    lead:
      'Euro jest warte więcej niż złoty, więc przeliczenie EUR na PLN zawsze daje większą liczbę niż kwota wyjściowa. '
      + 'Samo przeliczenie robi {{app}}, także bez zasięgu, a ta strona tłumaczy, dlaczego księgowa i kantor podają tego samego dnia inne liczby.',
    h2: 'Kto w Polsce przelicza euro na złote',
    body: [
      'To najczęściej sprawdzany kurs w kraju, bo Polska należy do Unii Europejskiej, ale została przy złotym i nie ma wyznaczonej daty przyjęcia wspólnej waluty. Euro pojawia się przy wakacjach we Włoszech, Grecji czy Chorwacji, która weszła do strefy euro 1 stycznia 2023 roku, przy zamówieniach w niemieckich sklepach internetowych i przy fakturach wystawianych kontrahentom ze strefy euro.',
      'Dla firmy liczy się jednak inna liczba niż dla turysty. Narodowy Bank Polski publikuje tabelę A kursów średnich w każdy dzień roboczy, około południa, i to ona służy do przeliczeń podatkowych: fakturę w euro księguje się po kursie średnim z ostatniego dnia roboczego poprzedzającego dzień powstania obowiązku podatkowego. Kantor tego samego dnia poda zupełnie inną wartość i obie będą poprawne, tylko do czego innego.',
      'Przy gotówce i przelewach realnym kosztem jest spread, czyli różnica między kursem kupna i sprzedaży. Kantory internetowe zbudowały w Polsce osobny rynek właśnie dlatego, że potrafią ten spread zawęzić mocniej niż oddział banku.',
    ],
    tips: {
      h3: 'Praktyczne uwagi do pary EUR/PLN',
      items: [
        'Obie waluty mają dwa miejsca po przecinku: euro dzieli się na centy, złoty na grosze.',
        'Do księgowania i rozliczeń podatkowych obowiązuje kurs średni z tabeli A Narodowego Banku Polskiego, a nie kurs z kantoru.',
        'W terminalu w strefie euro wybieraj płatność w euro; przeliczenie proponowane przez sprzedawcę jest zwykle droższe.',
        'Chorwacja płaci euro od 2023 roku, więc jeden kurs obsłuży wakacje od Adriatyku po Portugalię.',
        'Para reaguje na posiedzenia Rady Polityki Pieniężnej i Europejskiego Banku Centralnego, ogłaszane w kalendarzu z góry.',
      ],
    },
    faq: [
      {
        q: 'Po jakim kursie przeliczyć fakturę wystawioną w euro?',
        a: 'Do celów podatkowych stosuje się kurs średni Narodowego Banku Polskiego z ostatniego dnia roboczego poprzedzającego dzień powstania przychodu lub wystawienia dokumentu. Kurs z {{app}} jest orientacyjny i nadaje się do szybkiego oszacowania, nie do zapisu w księgach.',
      },
      {
        q: 'Bank czy kantor internetowy — gdzie wymienić euro?',
        a: 'Decyduje spread, a nie nazwa. Porównaj kurs sprzedaży w obu miejscach z kursem referencyjnym i policz kwotę końcową w złotych. Przy większych sumach różnica potrafi przewyższyć każdą osobno wykazaną prowizję.',
      },
    ],
  },

  'chf-pln': {
    lead:
      'Frank szwajcarski jest wart więcej niż złoty, więc przeliczenie CHF na PLN zawsze daje większą liczbę niż kwota wyjściowa. '
      + 'Dla kredytobiorców to nie ciekawostka rynkowa, tylko wysokość raty — przelicza ją {{app}}, a ta strona opowiada, skąd ten kurs wziął się w polskich domach.',
    h2: 'Dlaczego kurs franka śledzi się w Polsce codziennie',
    body: [
      'Ta para ma w Polsce własną historię społeczną. Kredyty mieszkaniowe indeksowane i denominowane do franka udzielane były masowo w latach 2005–2008, a ich spłata rozciągnęła się na dekady. Dla tych gospodarstw domowych kurs CHF/PLN wyznacza zarówno miesięczną ratę, jak i saldo zadłużenia przeliczone na złote.',
      'Dwa wydarzenia ustawiły ten rynek. Nowelizacja prawa bankowego z 2011 roku, znana jako ustawa antyspreadowa, dała kredytobiorcom prawo do spłaty rat bezpośrednio w walucie kredytu, więc franki można kupić tam, gdzie kurs jest lepszy niż w tabeli banku. W styczniu 2015 roku Szwajcarski Bank Narodowy zniósł minimalny kurs euro wobec franka, którego bronił od września 2011 roku, i frank umocnił się skokowo w ciągu jednego dnia.',
      'Sam frank pełni rolę waluty schronienia: drożeje, gdy na rynkach robi się nerwowo. Złoty w takich momentach zwykle słabnie, więc oba ruchy sumują się w jednym kursie. Poza kredytami parę sprawdzają Polacy pracujący w Szwajcarii oraz kupujący tam sprzęt, zegarki i leki.',
    ],
    tips: {
      h3: 'Praktyczne uwagi do pary CHF/PLN',
      items: [
        'Ustawa antyspreadowa pozwala spłacać kredyt bezpośrednio we frankach, kupionych poza bankiem prowadzącym umowę.',
        'W dniu raty porównaj kurs sprzedaży z tabeli banku z kursem kantoru — różnica dotyczy każdej płatności z osobna.',
        'Saldo kredytu przeliczaj kalkulatorem w kierunku z franków na złote, tak jak robi to harmonogram spłaty.',
        'Frank zyskuje w napięciach rynkowych dokładnie wtedy, gdy waluty regionu tracą; para reaguje z obu stron naraz.',
        'Szwajcaria nie należy do Unii Europejskiej, więc przy przesyłkach do Polski dochodzi odprawa celna i podatek.',
      ],
    },
    faq: [
      {
        q: 'Czy mogę spłacać kredyt frankami kupionymi poza bankiem?',
        a: 'Tak. Nowelizacja prawa bankowego z 2011 roku, nazywana ustawą antyspreadową, dała kredytobiorcom prawo do spłaty rat w walucie kredytu bez dodatkowych opłat. Walutę wolno kupić tam, gdzie kurs sprzedaży jest korzystniejszy.',
      },
      {
        q: 'Dlaczego frank drożeje akurat wtedy, gdy dzieje się źle?',
        a: 'Bo jest traktowany jako waluta schronienia: w okresach niepewności kapitał płynie do Szwajcarii i podbija jego wycenę. Waluty rynków wschodzących, w tym złoty, w tym samym czasie zwykle tracą, więc para porusza się podwójnie mocno.',
      },
    ],
  },

  'usd-pln': {
    lead:
      'Dolar amerykański jest wart więcej niż złoty, więc przeliczenie USD na PLN daje większą liczbę niż kwota wyjściowa. '
      + 'Samo przeliczenie robi {{app}} w telefonie, również z zapisanych kursów po utracie sieci, a ta strona pokazuje, gdzie dolar wchodzi do polskiego rozliczenia.',
    h2: 'Gdzie w polskim portfelu pojawia się dolar',
    body: [
      'Dolar rzadko bywa u nas gotówką w portfelu. Znacznie częściej jest walutą faktury: programiści na kontraktach, graficy, studia gier i firmy usługowe rozliczają się z klientami zza oceanu w dolarach, a przychód i tak trzeba wykazać w złotych.',
      'Druga grupa to inwestorzy. Akcje i fundusze ETF notowane w Nowym Jorku kupuje się za dolary, a przy rozliczeniu PIT-38 każdą transakcję oraz dywidendę przelicza się po kursie średnim NBP z dnia roboczego poprzedzającego jej realizację. Rachunek maklerski pokazuje wynik w dolarach, urząd skarbowy chce go w złotych — więc realny zysk zależy również od tego, co w międzyczasie zrobił kurs.',
      'Trzeci powód to zakupy w amerykańskich sklepach. Od lipca 2021 roku każda przesyłka spoza Unii jest objęta podatkiem VAT bez względu na wartość, a powyżej progu 150 euro dochodzi cło, liczone od wartości przeliczonej na złote. Do tego ceny na amerykańskich półkach podaje się bez podatku sprzedaży, doliczanego dopiero przy kasie i innego w każdym stanie.',
    ],
    tips: {
      h3: 'Praktyczne uwagi do pary USD/PLN',
      items: [
        'Do zeznania rocznego stosuje się kurs średni NBP z dnia roboczego poprzedzającego transakcję, a nie kurs pokazany przez brokera.',
        'Amerykańskie ceny detaliczne są podawane bez podatku sprzedaży, więc kwota do zapłaty rośnie dopiero przy kasie.',
        'Konto walutowe w dolarach pozwala przetrzymać wpływ z faktury i wymienić go w wybranym momencie.',
        'Para reaguje na decyzje Rezerwy Federalnej i na dane z amerykańskiego rynku pracy, publikowane w stałym kalendarzu.',
        'Dolar bywa kwotowany wobec koszyka walut, więc USD/PLN potrafi się ruszyć bez żadnej informacji z Polski.',
      ],
    },
    faq: [
      {
        q: 'Po jakim kursie rozliczyć zyski z amerykańskiej giełdy?',
        a: 'Przychody i koszty przelicza się po kursie średnim Narodowego Banku Polskiego z ostatniego dnia roboczego poprzedzającego dzień uzyskania przychodu albo poniesienia kosztu. Liczba z {{app}} służy do oszacowania, a do zeznania bierze się tabelę z konkretnej daty.',
      },
      {
        q: 'Czy paczka ze Stanów będzie obciążona cłem i podatkiem?',
        a: 'VAT należy się od każdej przesyłki spoza Unii Europejskiej, niezależnie od jej wartości. Cło pojawia się powyżej progu 150 euro wartości towaru. Podstawą jest kwota przeliczona na złote, dlatego warto ją policzyć jeszcze przed złożeniem zamówienia.',
      },
    ],
  },

  'gbp-pln': {
    lead:
      'Funt szterling jest wart więcej niż złoty, więc przeliczenie GBP na PLN daje większą liczbę niż kwota wyjściowa. '
      + 'Dla polskiej diaspory na Wyspach to liczba z dnia wypłaty — przelicza ją {{app}}, a ta strona tłumaczy, dlaczego ten sam przelew wypada inaczej w środę i w sobotę.',
    h2: 'Wypłata w funtach, zobowiązania w złotych',
    body: [
      'Polacy pozostają jedną z największych grup imigranckich w Wielkiej Brytanii, a przekazy z Wysp do Polski są jednym z najbardziej ruchliwych korytarzy pieniężnych w Europie. Ta społeczność jest dziś mniejsza niż w szczycie z 2017 roku, ale wciąż liczy setki tysięcy osób, a schemat pozostaje powtarzalny: pensja wpływa w funtach, natomiast rata kredytu w Polsce, czynsz rodziców albo oszczędności na mieszkanie liczą się w złotych. Kurs sprawdza się więc regularnie, w rytmie wypłat, a nie sesji giełdowych.',
      'W przekazach pieniężnych najważniejszy jest jednak nie cennik, tylko marża wbudowana w kurs. Usługa może reklamować się brakiem prowizji i zarabiać na różnicy między własnym kursem a rynkiem międzybankowym. Jedynym uczciwym porównaniem jest kwota, która realnie ląduje na polskim koncie.',
      'Do tego dochodzi rytm tygodnia. Rynek międzybankowy stoi od piątkowego wieczoru do niedzieli, więc kursy weekendowe zawierają zapas na ryzyko poniedziałkowego otwarcia. Ten sam przelew zlecony w środę i w sobotę potrafi dać różny wynik, choć nic w gospodarce się nie zmieniło.',
    ],
    tips: {
      h3: 'Praktyczne uwagi do pary GBP/PLN',
      items: [
        'Porównuj kwotę, która dojdzie do odbiorcy w złotych, a nie samą wysokość prowizji — marża siedzi w kursie.',
        'Weekendowe kursy przekazów bywają gorsze, bo rynek międzybankowy jest wtedy zamknięty.',
        'Banknoty szkockie i północnoirlandzkie to ten sam funt i ten sam kurs, ale polskie kantory bywają wobec nich nieufne.',
        'Funt dzieli się na sto pensów, więc przy przeliczeniu nic nie ginie na zaokrągleniu.',
        'Przy jednym większym przelewie opłata stała rozkłada się na większą kwotę niż przy kilku drobnych.',
      ],
    },
    faq: [
      {
        q: 'Kiedy najlepiej wysyłać pieniądze z Wysp do Polski?',
        a: 'W dniu roboczym, gdy rynek międzybankowy pracuje. W weekend pośrednicy kwotują z szerszym zapasem, bo do poniedziałku kurs może się przesunąć, a to ryzyko wliczają w cenę przekazu.',
      },
      {
        q: 'Czy banknot szkocki jest wart tyle samo co angielski?',
        a: 'Tak, to ta sama waluta i ten sam kurs. Noty emitowane w Szkocji i Irlandii Północnej bywają jednak nieznane kasjerom poza Wyspami, więc w polskim kantorze łatwiej wymienić banknoty Banku Anglii.',
      },
    ],
  },

  'uah-pln': {
    lead:
      'Hrywna jest warta ułamek złotego, więc przeliczenie UAH na PLN daje mniejszą liczbę niż kwota wyjściowa. '
      + 'W tym korytarzu pieniądze płyną jednak głównie w drugą stronę, a oba kierunki liczy {{app}}, również wtedy, gdy zasięg się urywa.',
    h2: 'Praca w złotych, zobowiązania w hrywnie',
    body: [
      'Obywatele Ukrainy tworzą dziś największą grupę cudzoziemców na polskim rynku pracy. Pensja jest w złotych, ale rodzina, rachunki i często kredyt zostały po drugiej stronie granicy, więc kurs sprawdza się przed przelewem, a nie przy okienku kantoru.',
      'Sama hrywna nie jest walutą swobodnie wymienialną poza Ukrainą. Od lutego 2022 roku Narodowy Bank Ukrainy trzymał kurs usztywniony wobec dolara, a w październiku 2023 roku przeszedł na kurs zarządzany, korygowany stopniowo. Notowanie wobec złotego powstaje więc pośrednio, przez dolara, i ramy wyznacza mu bank centralny, a nie swobodny obrót.',
      'W praktyce oznacza to, że gotówka jest tu najgorszym nośnikiem. Polskie kantory rzadko skupują hrywnę, a jeśli już, to z bardzo szerokim spreadem, bo banknotów nie da się łatwo odesłać do kraju emisji. Przelew na ukraiński rachunek albo karta tamtejszego banku wypada zwykle taniej niż wożenie gotówki przez granicę.',
    ],
    tips: {
      h3: 'Praktyczne uwagi do pary UAH/PLN',
      items: [
        'Gotówkę w hrywnie skupuje w Polsce niewiele punktów, a spread bywa wielokrotnie szerszy niż przy euro.',
        'Notowanie hrywny powstaje pośrednio przez dolara, więc zależy również od tego, co robi kurs USD/PLN.',
        'Kanał przekazu ma znaczenie: wypłata gotówki i przelew na rachunek bywają wyceniane inaczej u tego samego pośrednika.',
        'Hrywna dzieli się na sto kopiejek i zapisuje się ją z dwoma miejscami po przecinku.',
        '{{app}} przechowuje ostatni kurs w telefonie, co pomaga tam, gdzie zasięg bywa przerywany.',
      ],
    },
    faq: [
      {
        q: 'Gdzie w Polsce wymienić gotówkę w hrywnach?',
        a: 'Skupuje ją tylko część kantorów i banków, zwykle po znacznie gorszym kursie niż waluty strefy euro. Zanim staniesz w okienku, porównaj wynik z kursem referencyjnym oraz z kosztem zwykłego przelewu na ukraiński rachunek.',
      },
      {
        q: 'Dlaczego kurs hrywny jest tak spokojny mimo wojny?',
        a: 'Bo hrywna nie płynie swobodnie. Narodowy Bank Ukrainy najpierw usztywnił kurs wobec dolara, a od października 2023 roku prowadzi kurs zarządzany i koryguje go stopniowo. Spokojne jest notowanie urzędowe — marże kantorów i pośredników już nie.',
      },
    ],
  },

  'nok-pln': {
    lead:
      'Jedna korona norweska jest warta mniej niż jeden złoty, więc przeliczenie NOK na PLN daje mniejszą liczbę niż kwota wyjściowa. '
      + 'To pierwsze zaskoczenie przy norweskim pasku wypłaty — przeliczy go {{app}}, a ta strona wyjaśnia, czym korona różni się od złotego poza samą liczbą.',
    h2: 'Norweska wypłata przeliczona na złote',
    body: [
      'Polacy od lat należą do najliczniejszych grup imigranckich w Norwegii. Pracują na budowach, w stoczniach, przy przetwórstwie ryb i w usługach, często w systemie rotacyjnym: kilka tygodni na miejscu, potem powrót do domu. Dlatego kurs sprawdza się co wypłatę albo co rotację, a nie przed wakacjami.',
      'Liczba na pasku wygląda imponująco, dopóki nie zostanie przeliczona, bo korona jest warta mniej niż złoty. To samo działa w drugą stronę przy cenach: norweski rachunek zapisany czterocyfrową liczbą bywa mniej straszny, niż wygląda, choć poziom cen i tak jest wysoki.',
      'Korona norweska to waluta surowcowa i mały rynek jednocześnie. Reaguje na ceny ropy i gazu oraz na nastroje globalne mocniej niż euro na tę samą wiadomość, a Norges Bank prowadzi własną politykę stóp. Sama Norwegia należy do Europejskiego Obszaru Gospodarczego, ale nie do Unii i nie do unii celnej, więc przesyłka stamtąd do Polski przechodzi odprawę.',
    ],
    tips: {
      h3: 'Praktyczne uwagi do pary NOK/PLN',
      items: [
        'Korona norweska podąża za cenami surowców energetycznych, więc potrafi się ruszyć bez żadnej informacji z kraju.',
        'W Norwegii gotówka jest w odwrocie; realnie płacisz kursem przewalutowania swojej karty.',
        'Skrót „kr” noszą także korony szwedzka i duńska — przy cenniku sprawdzaj kod NOK.',
        'Rozliczenie podatku wpływa w koronach; przelicz je, zanim zaplanujesz wydatek w złotych.',
        'Norwegia jest poza unią celną Unii Europejskiej, więc przy wysyłce towarów do Polski dochodzi odprawa.',
      ],
    },
    faq: [
      {
        q: 'Czy jadąc do Norwegii warto brać gotówkę?',
        a: 'Rzadko się przydaje. Norwegia należy do krajów o najniższym udziale gotówki w płatnościach, a karty i płatności mobilne działają nawet w drobnych punktach. Ważniejsze jest sprawdzenie, jaką marżę za transakcję walutową nalicza twój bank.',
      },
      {
        q: 'Dlaczego kurs korony norweskiej tak się waha?',
        a: 'Bo to waluta niewielkiego, otwartego rynku, silnie powiązanego z eksportem ropy i gazu. Przy tej samej wiadomości korona porusza się zwykle mocniej niż euro, a decyzje norweskiego banku centralnego potrafią odwrócić kierunek w kilka minut.',
      },
    ],
  },

  'czk-pln': {
    lead:
      'Jedna korona czeska jest warta mniej niż jeden złoty, więc przeliczenie CZK na PLN daje mniejszą liczbę niż kwota z czeskiego cennika. '
      + 'Liczbę z metki przelicza {{app}}, także bez zasięgu, a ta strona tłumaczy, dlaczego czeska cena wygląda drożej, niż jest.',
    h2: 'Para przygraniczna, nie giełdowa',
    body: [
      'Cieszyn i Czeski Cieszyn to jedno miasto rozdzielone Olzą, a przejścia w Kudowie, Zebrzydowicach czy Boboszowie obsługują codzienny ruch po zakupy, na narty, do pracy i do restauracji. Kurs korony czeskiej sprawdza się więc na miejscu, ze smartfonem przy cenniku, a nie przed planowanym wyjazdem.',
      'Najczęstszy błąd polega na czytaniu czeskiej ceny tak, jakby była zapisana w złotych. Skoro korona jest warta mniej, liczba na metce jest wyższa, a wartość niższa, niż podpowiada odruch. Cenę zapisuje się liczbą i skrótem „Kč” na końcu. Halerze wycofano z obiegu w 2008 roku, więc w praktyce płaci się pełnymi koronami.',
      'Czechy pozostają w Unii Europejskiej przy własnej walucie. Czeski Bank Narodowy w latach 2013–2017 utrzymywał zobowiązanie do niedopuszczania do umocnienia korony wobec euro i zniósł je w kwietniu 2017 roku; od tamtej pory kurs znów wyznacza rynek.',
    ],
    tips: {
      h3: 'Praktyczne uwagi do pary CZK/PLN',
      items: [
        'Czeskie ceny zapisuje się z „Kč” po liczbie i są to liczby wyższe niż polskie odpowiedniki.',
        'Halerz zniknął z obiegu w 2008 roku, więc gotówką płaci się pełnymi koronami.',
        'W czeskim terminalu wybieraj płatność w koronach — przeliczenie na złote proponuje sprzedawca, nie twój bank.',
        'Kantory tuż przy przejściu granicznym zwykle oferują gorszy kurs niż punkty w centrach miast.',
        'Czechy należą do unii celnej, więc przy zakupach nie dochodzi cło ani dodatkowa odprawa.',
      ],
    },
    faq: [
      {
        q: 'Czy w Czechach zapłacę złotówkami?',
        a: 'W sklepach przy granicy i w części ośrodków narciarskich tak, ale po kursie ustalonym przez sprzedawcę. Prawnym środkiem płatniczym jest korona czeska, a płatność kartą w koronach albo wypłata z bankomatu wypada zwykle bliżej kursu referencyjnego.',
      },
      {
        q: 'Dlaczego czeskie ceny wyglądają na wyższe niż polskie?',
        a: 'Bo jedna korona czeska jest warta mniej niż jeden złoty, więc ta sama wartość zapisana jest większą liczbą. Przelicz kwotę z cennika, zanim porównasz ją z polską ceną — po przeliczeniu wynik bywa odwrotny, niż sugeruje sam zapis.',
      },
    ],
  },

  'sek-pln': {
    lead:
      'Jedna korona szwedzka jest warta mniej niż jeden złoty, więc przeliczenie SEK na PLN daje mniejszą liczbę niż kwota wyjściowa. '
      + 'Oba kierunki liczy {{app}} w telefonie, a ta strona tłumaczy, dlaczego w Szwecji ważniejszy od kursu bywa sposób płatności.',
    h2: 'Szwecja z własną koroną i bez gotówki',
    body: [
      'Szwecja została przy koronie z wyboru: w referendum z 2003 roku odrzuciła przyjęcie euro i nie wyznaczyła nowej daty. Dla Polaka kurs pojawia się przy pracy sezonowej i kontraktach na miejscu, przy zamówieniach ze szwedzkich sklepów internetowych oraz przy promie ze Świnoujścia do Ystad i z Gdyni do Karlskrony.',
      'Na miejscu zaskakuje co innego niż liczby. Szwecja poszła w płatności bezgotówkowe dalej niż niemal cały świat: sklepy, muzea i przewoźnicy potrafią w ogóle nie przyjmować banknotów, a lokalne płatności telefonem wymagają tamtejszego konta. Wymiana gotówki przed wyjazdem jest tu najmniej użyteczna spośród wszystkich europejskich kierunków.',
      'Sama korona należy do bardziej zmiennych walut Europy. Rynek jest niewielki, gospodarka mocno zależy od eksportu przemysłowego, a decyzje Riksbanku potrafią przestawić kurs w ciągu jednej sesji. Ceny detaliczne zawierają już podatek, więc kwota z metki jest kwotą do zapłaty.',
    ],
    tips: {
      h3: 'Praktyczne uwagi do pary SEK/PLN',
      items: [
        'Skrót „kr” wygląda identycznie w Szwecji, Norwegii i Danii — przy porównaniu cen szukaj kodu SEK.',
        'Wiele szwedzkich punktów nie przyjmuje banknotów, więc realnym kursem jest kurs twojej karty.',
        'Szwedzkie ceny detaliczne podawane są z podatkiem, bez niespodzianki przy kasie.',
        'Opłaty promowe i portowe bywają wystawiane w koronach — przelicz je przed rezerwacją.',
        'Riksbank ogłasza decyzje w znanym z góry kalendarzu, a korona reaguje na nie mocniej niż euro.',
      ],
    },
    faq: [
      {
        q: 'Czy Szwecja przyjmie kiedyś euro?',
        a: 'Nie ma takiego planu. Szwedzi odrzucili wspólną walutę w referendum z 2003 roku, a kraj nie przystąpił do mechanizmu ERM II, który jest warunkiem wstępnym. W praktyce oznacza to pozostanie przy koronie na nieokreślony czas.',
      },
      {
        q: 'Ile gotówki zabrać do Szwecji?',
        a: 'Zwykle najmniej ze wszystkich kierunków. Karty wystarczają w transporcie, sklepach i muzeach, a część placówek bankowych w ogóle nie obsługuje wpłat i wypłat gotówkowych. Banknoty bywają w Szwecji trudniejsze do wydania niż karta wydana w Polsce.',
      },
    ],
  },

  'dkk-pln': {
    lead:
      'Korona duńska jest sztywno związana z euro, więc kurs DKK/PLN porusza się praktycznie tak samo jak kurs euro do złotego. '
      + 'Za jedną koronę dostaniesz mniej niż złotówkę; przeliczy ją {{app}}, a ta strona opisuje mechanizm, który trzyma ten kurs w miejscu.',
    h2: 'Waluta, która nie ma własnego wykresu',
    body: [
      'Dania należy do Unii Europejskiej, ale nie do strefy euro. Od 1999 roku uczestniczy w mechanizmie ERM II z ustalonym kursem centralnym wobec euro i dopuszczalnym pasmem wahań, którego Danmarks Nationalbank pilnuje znacznie ciaśniej, niż musi. W Unii to rozwiązanie wyjątkowe, a jego celem jest właśnie brak niespodzianek.',
      'Konsekwencja dla tej pary jest prosta: notowanie DKK/PLN nie ma własnej historii. Jest kursem euro do złotego podzielonym przez prawie niezmienną liczbę, więc wykres wygląda jak wykres EUR/PLN. Duński bank centralny nie ustawia stóp procentowych pod inflację, tylko pod obronę tego powiązania.',
      'Skoro sam kurs stoi w miejscu, cała różnica między ofertami bierze się z narzutu pośrednika. Dla Polaków pracujących w Danii, w rolnictwie, budownictwie i gastronomii, to jedyna zmienna, na którą naprawdę mają wpływ. Na miejscu warto pamiętać, że duński podatek od towarów wynosi 25% i jest już wliczony w cenę na półce.',
    ],
    tips: {
      h3: 'Praktyczne uwagi do pary DKK/PLN',
      items: [
        'Kurs centralny wobec euro jest ustalony, dlatego para DKK/PLN naśladuje ruchy EUR/PLN.',
        'Skoro kurs prawie nie drgnie, o wyniku wymiany decyduje wyłącznie marża banku, kantoru albo karty.',
        'Duńskie ceny zawierają podatek w wysokości 25%, więc kwota z metki jest kwotą do zapłaty.',
        'W Danii kartą zapłacisz praktycznie wszędzie, a gotówka rzadko bywa potrzebna.',
        'Skrót „kr” oznacza też koronę norweską i szwedzką — na paragonie szukaj kodu DKK.',
      ],
    },
    faq: [
      {
        q: 'Czy kurs korony duńskiej w ogóle się zmienia?',
        a: 'Wobec euro prawie nie. Dania uczestniczy w mechanizmie ERM II z ustalonym kursem centralnym wobec euro i wąskim pasmem wahań, którego pilnuje bank centralny. Wobec złotego korona rusza się tylko dlatego, że rusza się złoty wobec euro.',
      },
      {
        q: 'Skoro kurs stoi w miejscu, dlaczego oferty wymiany się różnią?',
        a: 'Bo różni je narzut. Do usztywnionego kursu każdy pośrednik dokłada własną marżę i ewentualną opłatę stałą. Dwa punkty powołujące się na ten sam kurs urzędowy wypłacą różne sumy, a porównać można je tylko po kwocie końcowej.',
      },
    ],
  },

  'huf-pln': {
    lead:
      'Forint jest wart znacznie mniej niż złoty, więc przeliczenie HUF na PLN zamienia bardzo duże liczby na małe kwoty. '
      + 'To najczęstsze zaskoczenie przy pierwszym rachunku w Budapeszcie — rachunek przeliczy {{app}}, a ta strona wyjaśnia, skąd na węgierskiej metce tyle cyfr.',
    h2: 'Węgierskie ceny i ich cyfry',
    body: [
      'Węgry są dla Polaków kierunkiem weekendowym i tranzytowym naraz: Budapeszt, kąpieliska termalne, Balaton, a po drodze autostrady prowadzące dalej na południe. Ceny podaje się w forintach, ze skrótem „Ft” po liczbie, i to właśnie długość liczby wywołuje najwięcej nieporozumień. Rachunek złożony z czterech albo pięciu cyfr jest w restauracji zupełnie zwyczajny.',
      'Formalnie forint dzieli się na sto fillérów, ale fillér wycofano z obiegu w 1999 roku i od tego czasu ceny podaje się w pełnych jednostkach. Monety o nominale jednego i dwóch forintów zniknęły w 2008 roku, więc płatności gotówkowe zaokrągla się do pełnych pięciu forintów, podczas gdy karta rozlicza kwotę dokładnie.',
      'Węgry pozostają w Unii Europejskiej przy własnej walucie i bez wyznaczonej daty przyjęcia euro, a Narodowy Bank Węgier (Magyar Nemzeti Bank) prowadzi samodzielną politykę stóp. Dla kierowcy najbardziej praktyczny wniosek dotyczy winiety: elektroniczne uprawnienie do przejazdu kupuje się w forintach, podobnie jak paliwo i opłaty po drodze.',
    ],
    tips: {
      h3: 'Praktyczne uwagi do pary HUF/PLN',
      items: [
        'Kwotę zapisuje się liczbą, a skrót „Ft” stawia się po niej; ceny czterocyfrowe to codzienność.',
        'Fillér zniknął z obiegu w 1999 roku, więc końcówek groszowych na węgierskim paragonie nie ma.',
        'Płatności gotówkowe zaokrągla się do pełnych pięciu forintów, bo najdrobniejsze monety wycofano w 2008 roku.',
        'W węgierskim bankomacie i terminalu odmawiaj przeliczenia na złote; to kurs ustalany przez pośrednika.',
        'Winietę na autostrady kupujesz w forintach — przelicz ją razem z paliwem, planując tranzyt na południe.',
      ],
    },
    faq: [
      {
        q: 'Dlaczego węgierskie rachunki mają tyle cyfr?',
        a: 'Bo jeden forint jest wart znacznie mniej niż jeden złoty, a jego setna część zniknęła z obiegu w 1999 roku. Kwoty cztero- i pięciocyfrowe są zwykłymi cenami, a nie pomyłką; wystarczy je przeliczyć, zanim ocenisz, czy to drogo.',
      },
      {
        q: 'Czy w Budapeszcie zapłacę kartą albo w euro?',
        a: 'Kartą praktycznie wszędzie, euro tylko miejscami i po kursie ustalonym przez sprzedawcę. Prawnym środkiem płatniczym jest forint, więc płatność w walucie lokalnej daje wynik bliższy kursowi referencyjnemu niż przeliczenie proponowane w kasie.',
      },
    ],
  },

  'pln-eur': {
    lead:
      'Złoty jest wart mniej niż euro, więc przeliczenie PLN na EUR zawsze daje mniejszą liczbę niż kwota wyjściowa. '
      + 'Tak wygląda planowanie budżetu wyjazdowego, a {{app}} przelicza go dalej również bez zasięgu.',
    h2: 'Ile euro zrobi się z polskiego budżetu',
    body: [
      'Ten kierunek to pytanie planistyczne: ile wspólnej waluty wyjdzie z odłożonej kwoty w złotych. Pada przed wyjazdem do Włoch, Grecji, Hiszpanii i Chorwacji, przy rezerwacji noclegu wycenionego w euro oraz przy zamówieniu w zagranicznym sklepie, w którym koszyk przelicza się dopiero na etapie płatności.',
      'Karta wydana w Polsce prowadzi rachunek w złotych, więc każda transakcja w euro przechodzi przewalutowanie. Decydują trzy rzeczy: kurs organizacji kartowej z dnia rozliczenia, a nie z dnia zakupu; ewentualna prowizja banku za transakcję walutową; oraz to, czy zgodzisz się na przeliczenie proponowane przez terminal lub bankomat. Ta ostatnia opcja jest z reguły najdroższa z całej transakcji.',
      'Alternatywą jest rachunek walutowy albo karta wielowalutowa: walutę kupujesz wtedy, kiedy uznasz kurs za rozsądny, a potem płacisz bez przewalutowania. Gotówka wciąż ma sens tam, gdzie karta bywa zawodna — w małych pensjonatach, na targach i w taksówkach.',
    ],
    tips: {
      h3: 'Praktyczne uwagi do pary PLN/EUR',
      items: [
        'Płacąc kartą za granicą, zawsze wybieraj walutę lokalną; przeliczenie z terminala jest przeliczeniem sprzedawcy.',
        'Transakcja rozlicza się po kursie z dnia księgowania, a nie z dnia, w którym przyłożyłeś kartę.',
        'Rachunek walutowy pozwala kupić walutę wcześniej i wyjechać bez przewalutowania przy każdej płatności.',
        'Bankomat też zaproponuje wypłatę „w złotych” — to ta sama pułapka co w terminalu sklepowym.',
        'Sprawdź prowizję swojego banku za transakcję zagraniczną; bywa naliczana osobno od samego kursu.',
      ],
    },
    faq: [
      {
        q: 'Kupić walutę w kantorze przed wyjazdem czy wypłacić ją z bankomatu na miejscu?',
        a: 'Zależy od twojego banku. Wypłata za granicą rozlicza się po kursie organizacji kartowej powiększonym o prowizje, a kantor internetowy potrafi wypaść korzystniej przy większych kwotach. Porównuj kwoty końcowe, a nie same kursy.',
      },
      {
        q: 'Czym jest DCC i dlaczego rzadko się opłaca?',
        a: 'To przeliczenie waluty proponowane przez terminal albo bankomat: sprzedawca przelicza transakcję na złote po własnym kursie i zatrzymuje marżę. Wybór waluty lokalnej oddaje przeliczenie twojemu bankowi, którego kurs jest zwykle bliższy referencyjnemu.',
      },
    ],
  },

  'pln-gbp': {
    lead:
      'Złoty jest wart mniej niż funt, więc przeliczenie PLN na GBP daje wyraźnie mniejszą liczbę niż kwota w złotych. '
      + 'Przelicza go {{app}}, pamiętając ostatni kurs na czas bez sieci, a ta strona pokazuje, komu ten właśnie kierunek jest potrzebny.',
    h2: 'Z polskim budżetem na Wyspy',
    body: [
      'W tę stronę parę sprawdzają wyjeżdżający, a nie zarabiający na miejscu: student rozliczający czesne i akademik, rodzice wysyłający pieniądze dziecku, turysta układający koszt kilku dni w Londynie. Od 2025 roku obywatele Unii potrzebują do wjazdu elektronicznego zezwolenia ETA, opłacanego w funtach jeszcze przed podróżą.',
      'Druga grupa to polscy sprzedawcy internetowi. Po wyjściu Wielkiej Brytanii z jednolitego rynku wysyłka do brytyjskiego klienta jest eksportem: dla przesyłek o wartości do 135 funtów tamtejszy podatek pobiera sprzedawca w momencie sprzedaży, a powyżej tej kwoty rozlicza się go przy odprawie. Próg wyrażony jest w funtach, więc cennik prowadzony w złotych trzeba przeliczać przy każdej większej zmianie kursu.',
      'Trzecia sprawa to sposób kwotowania. Rynek podaje funta jako walutę bazową, więc nagłówek mówi zwykle, ile złotych kosztuje jeden funt, a nie odwrotnie. Odczytanie tego na opak zawyża szacowaną siłę nabywczą budżetu.',
    ],
    tips: {
      h3: 'Praktyczne uwagi do pary PLN/GBP',
      items: [
        'Próg 135 funtów rozstrzyga, czy brytyjski podatek pobiera sprzedawca, czy urząd przy odprawie.',
        'Zezwolenie ETA dla obywateli Unii opłaca się w funtach, przed wyjazdem.',
        'Na Wyspach płaci się głównie zbliżeniowo; gotówka bywa niepotrzebna przez cały pobyt.',
        'Brytyjskie ceny detaliczne zawierają podatek, więc kwota z etykiety jest kwotą do zapłaty.',
        'Kurs reaguje na decyzje Banku Anglii, ogłaszane w kalendarzu znanym z góry.',
      ],
    },
    faq: [
      {
        q: 'Ile funtów wziąć na wyjazd do Wielkiej Brytanii?',
        a: 'Mniej, niż podpowiada odruch. Karty i płatności zbliżeniowe działają w transporcie, sklepach i większości lokali, więc banknoty przydają się głównie na targach i w drobnych punktach. Budżet lepiej przeliczyć w całości, a wymieniać go partiami.',
      },
      {
        q: 'Dlaczego kurs podaje się jako GBP/PLN, a nie odwrotnie?',
        a: 'Bo na rynku walutowym funt jest walutą bazową i kwotuje się go jako liczbę innych walut za jednego funta. W {{app}} kierunek odwracasz jednym dotknięciem, więc odczyt zgadza się z tym, o co pytasz.',
      },
    ],
  },
},

  ja: {
  'usd-jpy': {
    lead:
      '米ドル（USD）を日本円（JPY）に換算すると、円には流通している補助単位がないため、結果は小数のない整数で出ます。'
      + '計算そのものを引き受けるのは Android と iOS の無料アプリ {{app}} で、通信がないときは保存済みのレートを使います。このページが説明するのは、ドル円という組み合わせのほうです。',
    h2: 'ドル円を調べているのはどんな人か',
    body: [
      'ドル円（USD/JPY）は、日本でもっとも多く検索される通貨ペアです。ハワイやグアム、米国本土への旅行を控えた人、メーカー直販サイトや Amazon.com で個人輸入をする人、ドル建てのクラウドサービスやサブスクリプションを毎月払っている人が、それぞれ別の理由で同じ数字を追いかけています。',
      'アメリカの値札には売上税が含まれていないのが原則で、税率は州や市によって違います。飲食店ではさらにチップが乗ります。表示価格をそのまま円に直すと、実際に請求される金額より必ず小さく出るので、合計額のほうを換算する癖をつけたほうが安全です。',
      '現地のカード端末やホテルの精算で「日本円で決済しますか」と聞かれることがあります。これは店側が決めたレートで換算する仕組みで、米ドル建てを選び、円への換算はカード会社に任せたほうが、参考レートに近い金額で収まるのが普通です。ドル円は日米の金利差に強く反応するため、予約した日と出発する日でレートが違うのは、ごく当たり前のことです。',
      '個人輸入では、商品代金のほかに国際送料と、日本側で課される関税や消費税がかかります。これらは輸入した時点で税関が用いる換算率で円に直されるため、注文した日の水準とは一致しません。総額を見積もるときは、値札だけでなく送料と税を足した金額のほうを換算してください。',
    ],
    tips: {
      h3: 'ドル円で気をつけること',
      items: [
        '円には流通している補助単位がないため、換算結果は常に整数になります。',
        'アメリカの値札は税抜表示が基本で、州ごとの売上税がレジで加算されます。',
        'カード端末で日本円建ての決済を勧められたら断り、米ドル建てを選びます。',
        'ドル建てのサブスクリプションは、契約日ではなく請求処理日のレートで円が確定します。',
        '{{app}} は1日から5年までのチャートを描くので、いまの水準が過去と比べて高いか低いかが分かります。',
      ],
    },
    faq: [
      {
        q: 'アメリカで「日本円で決済しますか」と聞かれたら、どうすればいいですか。',
        a: '米ドル建てを選んでください。日本円建てを選ぶと店舗側が決めたレートで換算され、多くの場合カード会社の換算より不利になります。米ドルで決済すれば、明細にも米ドルで記録され、円への換算はカード会社が行います。',
      },
      {
        q: 'ドル建てのサブスクリプションは、いつのレートで円になりますか。',
        a: '契約した日ではなく、カード会社が決済を処理した日のレートが使われます。そのため、毎月同じ金額のサービスでも、請求される円の金額は月ごとに変わります。明細の円の金額が動くのは、値上げではなくレートの変化であることが多いです。',
      },
    ],
  },

  'krw-jpy': {
    lead:
      '韓国ウォン（KRW）を日本円（JPY）に換算すると、桁数が大きく減ります。ウォンにも円にも補助単位がないため、どちらも整数のままです。'
      + '実際に数字を出すのは {{app}} で、通信がなくても保存済みのレートで換算を続けます。ここでは、ウォンと円をやり取りする人が引っかかりやすい点を先に押さえます。',
    h2: 'ウォン円を調べているのはどんな人か',
    body: [
      'ウォン円（KRW/JPY）は、ソウルや釜山への旅行だけでなく、K-POP のアルバムやチケット、韓国コスメの購入で日常的に使われます。韓国側の通販サイトはウォン建てで値段を出すので、日本国内で買った場合と比べるには、その場で円に直す必要があります。送料や関税を含めた合計で比べないと、安く見えていたものが逆転することもあります。',
      'ウォンは ISO 4217 の指数が 0 で、補助単位が流通していません。そのためコーヒー一杯が四桁、食事が五桁という表示になります。韓国では日常会話で「万ウォン」を単位のように使い、最高額の紙幣も5万ウォン札です。桁をひとつ読み違えると十倍ずれるので、換算する前に桁を数えるのが確実です。',
      '韓国はカード決済の比率が非常に高く、小さな店でも端末が置かれています。一方で、韓国のオンライン決済では支払い通貨に日本円を選べる画面が出ることがあります。ここでウォン建てを選び、円への換算をカード会社に任せたほうが、条件は良くなるのが普通です。',
      '韓国には、旅行者が一定額以上を買った場合に付加価値税の払い戻しを受けられる仕組みがあります。店頭では税込の金額を払い、出国時や街なかの端末で戻ってくる形なので、その場の負担は値札どおりです。実際にいくら使ったかを円で正確に把握したいなら、払い戻しを受けたあとの金額で計算し直す必要があります。',
    ],
    tips: {
      h3: 'ウォン円で気をつけること',
      items: [
        'ウォンには補助単位がなく、円と同じく換算結果は整数になります。',
        '韓国のサイトで支払い通貨を選べる場合は、ウォン建てを選びます。',
        '「万ウォン」表記が多いので、換算する前に桁を数えて確認します。',
        '地下鉄やバス、コンビニでは交通カードにウォンでチャージして使います。',
        '韓国のサイトで買い物が多いなら、{{app}} でウォン円をお気に入りに登録しておくと毎回すぐ開けます。',
      ],
    },
    faq: [
      {
        q: '韓国の値段によく出てくる「1万ウォン」は、日本円でいくらですか。',
        a: '{{app}} に 10000 と入れれば、その時点の円換算額が出ます。「万ウォン」は通貨の単位ではなく、韓国で日常的に使われる数の言い方なので、まずウォンの金額に直してから入力してください。',
      },
      {
        q: '韓国旅行では現金を用意していったほうがいいですか。',
        a: '韓国はカード決済の比率が高く、多くの店で海外発行のカードが使えます。ただし小規模な食堂や一部の市場では現金のみのこともあるため、少額のウォンを持っておくと安心です。交通カードへのチャージにも現金が使えます。',
      },
    ],
  },

  'eur-jpy': {
    lead:
      'ユーロ（EUR）を日本円（JPY）に換算すると、ユーロは小数2桁、円は小数なしなので、結果は整数で表示されます。'
      + '換算は無料の {{app}} が行い、通信のない場所でも保存済みのレートで続きます。以下では、ユーロと円という組み合わせの中身を見ていきます。',
    h2: 'ユーロ円を調べているのはどんな人か',
    body: [
      'ユーロ円（EUR/JPY）は、フランス、イタリア、スペイン、ドイツをまとめて回る旅行でいちばん出番の多いレートです。ユーロを法定通貨とする国は20か国以上あり、国境を越えても同じレートのまま計算を続けられます。周遊型の旅程ほど、この一本で足りるという利点が効いてきます。',
      'ヨーロッパの小売価格には付加価値税が含まれています。日本の税込表示と同じ感覚で、書かれている金額をそのまま換算すれば支払額になります。旅行者向けの免税は、購入後に手続きをして払い戻しを受ける形なので、店頭で先に引かれるわけではありません。',
      '空港やターミナル駅の両替所は参考レートから離れた条件を出すことが多く、金額が小さいほど差が目立ちます。現地の銀行 ATM でユーロを引き出すか、ユーロ建てでカード払いするほうが、参考レートに近いのが普通です。ATM が「日本円で引き出しますか」と聞いてきたら、ユーロを選んでください。ユーロ円は欧州中央銀行と日本銀行の政策の差を映して動き、どちらも会合の日程を事前に公表しています。',
      'ユーロ硬貨は額面の側が共通で、裏面のデザインが発行国ごとに違います。ドイツで受け取った硬貨をスペインの自販機に入れても問題はなく、価値も換算のしかたも変わりません。紙幣のほうは全域で共通のデザインです。国をまたぐ旅程で、財布の中身を国境ごとに整理する必要はありません。',
    ],
    tips: {
      h3: 'ユーロ円で気をつけること',
      items: [
        '値札は付加価値税込みなので、表示金額をそのまま換算すれば支払額になります。',
        '空港の両替所より、現地の銀行 ATM でユーロを引き出すほうが条件が良いのが普通です。',
        'ATM やカード端末が日本円建てを勧めてきたら断り、ユーロ建てを選びます。',
        'ユーロ圏内なら、国が変わっても同じレートで計算を続けられます。',
        '免税は購入後の払い戻しなので、店頭では税込価格を換算して考えます。',
      ],
    },
    faq: [
      {
        q: 'ヨーロッパの値札は税込ですか、税抜ですか。',
        a: '小売価格には付加価値税が含まれているのが原則です。したがって値札の金額をそのまま円に換算すれば、レジで支払う額になります。旅行者向けの免税手続きは購入後に払い戻しを受ける仕組みで、店頭価格から差し引かれるわけではありません。',
      },
      {
        q: 'ユーロの現金は日本で替えるべきですか、現地で替えるべきですか。',
        a: 'どちらの空港でも、両替所の条件は参考レートから離れがちです。到着後に現地の銀行 ATM で引き出すか、ユーロ建てでカード決済するほうが、参考レートに近い水準になることが多いです。現金は当座に必要な分だけにしておくと無駄が出ません。',
      },
    ],
  },

  'twd-jpy': {
    lead:
      '新台湾ドル（TWD）を日本円（JPY）に換算すると、日本の物価に近い金額感の数字が出ます。'
      + '台湾では通貨を「元」と書くため、円や人民元と取り違えやすい点に注意してください。金額の換算は無料アプリの {{app}} に任せられます。',
    h2: '台湾ドル円を調べているのはどんな人か',
    body: [
      '台湾ドル円（TWD/JPY）は、台北や高雄への短い旅行でよく使われます。夜市の屋台、コンビニ、タクシー、鉄道の切符と、数十元から数百元の支払いが何度も続くため、ひとつずつ円に直す機会が多いのが特徴です。滞在日数が短いほど、両替の条件が旅費全体に占める割合は大きくなります。',
      '台湾では価格を「元」または「NT$」と書きます。漢字の「元」は中国本土の通貨と同じ字なので、値札だけを見ても区別がつきません。旅行者向けの表示では NT$ が使われることが多く、頭の NT が新台湾ドルの目印になります。新台湾ドルの ISO 4217 の指数は 2 ですが、日常の支払いは元単位で完結し、角や分を見かけることはまずありません。',
      '夜市や小さな食堂は現金が中心です。両替は空港の銀行窓口か市内の銀行、あるいはコンビニや銀行の ATM で海外発行のカードを使う方法が一般的で、機械によって手数料の条件が違います。参考レートを先に見ておくと、掲示された数字が妥当かどうかを判断できます。',
      'もうひとつ台湾らしいのが、レシートに印刷される統一発票の番号です。買い物のたびに受け取る紙が定期的な抽選の対象になっており、当選すれば新台湾ドルで受け取れます。旅行者でも対象になるため、金額を円で見積もりたくなったときには、やはりこのレートを使うことになります。',
    ],
    tips: {
      h3: '台湾ドル円で気をつけること',
      items: [
        '値札の「元」は新台湾ドルのことで、中国本土の通貨とは別のお金です。',
        '旅行者向けの表記は NT$ が多く、頭の NT が新台湾ドルの目印になります。',
        '夜市や個人商店は現金が中心なので、小額紙幣を用意しておきます。',
        '鉄道やバス、コンビニでは交通系の IC カードにチャージして使えます。',
        '出発前に {{app}} を一度開いてレートを保存しておけば、通信のない場所でも換算できます。',
      ],
    },
    faq: [
      {
        q: '台湾の「元」は中国の人民元と同じですか。',
        a: '別の通貨です。台湾で使われるのは新台湾ドル（TWD）で、中国本土の人民元（CNY）とは発行体もレートも異なります。台湾の値札に書かれた「元」は新台湾ドルを指すので、換算するときは TWD を選んでください。',
      },
      {
        q: '台湾旅行では現金とカードのどちらが必要ですか。',
        a: '都市部のデパートやチェーン店ではカードが使えますが、夜市や小さな食堂は現金のみのことが多いです。カードを主に使う予定でも、少額の新台湾ドルの現金を持っておくと、屋台や短距離のタクシーで困りません。',
      },
    ],
  },

  'thb-jpy': {
    lead:
      'タイバーツ（THB）を日本円（JPY）に換算すると、バーツの数字は円よりかなり小さくなります。屋台や市場の価格は二桁から三桁が中心です。'
      + '{{app}} なら、電波の弱い市場でも保存したレートで換算できます。ここではバーツと円をめぐる事情のほうをまとめます。',
    h2: 'バーツ円を調べているのはどんな人か',
    body: [
      'バーツ円（THB/JPY）は、バンコクやプーケット、チェンマイへの旅行でもっともよく使われるレートです。屋台の一皿、トゥクトゥクの運賃、マッサージの料金と、少額の支払いが一日に何度も発生するため、頭のなかで換算する回数が多くなります。長期滞在で家賃をバーツで払う人にとっては、毎月の生活費を円で把握するための基準にもなります。',
      'タイは日本円をそのままバーツに替えられる国です。街なかの両替商は日本円の買い取りレートを掲示しており、空港の到着ロビーの窓口より条件が良いことが多いのが通例です。掲示された数字と参考レートの差が、実質的な手数料にあたります。参考レートを知らずに窓口の数字だけを見ていると、その差に気づけません。',
      'バーツは100サタンに分かれますが、現金のやり取りはほぼバーツ単位で完結します。タイ国内では QR コードによる決済が広く普及しており、屋台にも読み取り用の紙が貼られていますが、多くは国内の銀行口座を前提にした仕組みです。旅行者は現金とカードを併用するのが現実的です。',
      '両替の際にはパスポートの提示を求められることがあり、店舗ごとに営業時間も違います。深夜便で着いた日は、条件の良い街なかの両替商が閉まっていることが多いので、初日の分だけ空港で替え、残りは翌日以降に市内で替えるという分け方がよく取られます。',
    ],
    tips: {
      h3: 'バーツ円で気をつけること',
      items: [
        'タイでは日本円から直接バーツに両替でき、街なかの両替商は掲示レートを比べられます。',
        '到着ロビーで全額を替えず、当座に必要な分だけにしておく人が多いです。',
        '屋台や市場は現金が中心で、小額紙幣があると支払いが楽になります。',
        'ATM の画面が日本円建ての引き出しを勧めてきたら、バーツを選びます。',
        '市場で電波が弱い場所でも、{{app}} は保存したレートで換算を続けます。',
      ],
    },
    faq: [
      {
        q: '日本円はタイでそのまま両替できますか。',
        a: 'できます。タイの両替商や銀行は日本円を主要通貨のひとつとして扱い、買い取りレートを掲示しています。掲示レートと参考レートの差が実質的な手数料になるので、両替する前に {{app}} で目安を確かめておくと比べやすくなります。',
      },
      {
        q: 'バーツの現金はどのくらい必要ですか。',
        a: 'ホテルやショッピングモールではカードが使えますが、屋台、市場、地方での移動は現金が前提になります。滞在日数と行き先に合わせて、小額紙幣を中心に用意しておくと支払いに困りません。',
      },
    ],
  },

  'cny-jpy': {
    lead:
      '中国人民元（CNY）を日本円（JPY）に換算すると、元の数字は円よりかなり小さくなります。通貨の名称が人民元、金額を数える単位が元です。'
      + '金額の換算を担当するのは無料アプリの {{app}} です。本文では、人民元と円の取引で押さえておきたい点を扱います。',
    h2: '人民元円を調べているのはどんな人か',
    body: [
      '人民元円（CNY/JPY）は、中国の取引先との見積もりや発注、越境 EC での仕入れ、上海や深圳への出張で使われます。個人でも、中国のサイトから直接買い物をする人や、購入代行に元建てで支払う人が同じ数字を確認しています。見積書の金額が大きいほど、換算する日のずれが利益に響きます。',
      '人民元にはレートが二つあります。CNY は中国本土のオンショア市場のレートで、中国人民銀行が毎営業日に基準値を示し、その周りの変動幅のなかで動きます。CNH は香港などで取引されるオフショア人民元で、こちらはより自由に動きます。両者は近い水準に収まりますが一致はせず、見積書がどちらに基づくかで金額が変わることがあります。',
      '口語では元を「块」と言い、値札では記号だけが書かれていることもあります。中国の通貨記号は日本円と同じ形なので、見た目だけでは混同しやすいところです。通貨コードが CNY か JPY かを確かめるのが確実です。中国本土の店頭ではモバイル決済が中心で、海外発行のカードを登録して使う道も広がっていますが、その場合の引き落としは元建てで行われ、円への換算はカード会社が行います。',
      '取引の実務では、増値税の発票と呼ばれる公式の領収書が経理処理の起点になります。発票に載るのは元の金額なので、日本側で経費に計上するときは、どの日のレートで円に直すかという社内の基準を先に決めておかないと、担当者ごとに違う円の金額が出てしまいます。',
    ],
    tips: {
      h3: '人民元円で気をつけること',
      items: [
        '通貨の名称は人民元、金額を数える単位が元で、どちらも同じお金を指します。',
        '見積もりを受け取ったら、オンショアの CNY かオフショアの CNH かを確認します。',
        '中国の通貨記号は日本円と同じ形なので、通貨コードで区別します。',
        'モバイル決済に海外発行のカードを登録した場合、円への換算はカード会社側で行われます。',
        '{{app}} は1日から5年までのチャートを描けるので、見積もりを出した時期との差を確かめられます。',
      ],
    },
    faq: [
      {
        q: 'CNY と CNH は何が違いますか。',
        a: 'CNY は中国本土で取引されるオンショア人民元で、中国人民銀行が毎営業日に基準値を示し、その周囲の変動幅のなかで動きます。CNH は香港などで取引されるオフショア人民元で、より自由に変動します。水準は近いものの、同じではありません。',
      },
      {
        q: '人民元と元は、どちらが正しい呼び方ですか。',
        a: '人民元は通貨そのものの名前で、元は金額を数えるときの単位です。値段を言うときは「100元」が自然で、通貨制度そのものを指すときに人民元と呼びます。口語では「块」も広く使われています。',
      },
    ],
  },

  'gbp-jpy': {
    lead:
      '英国ポンド（GBP）を日本円（JPY）に換算すると、ポンドの数字は円よりずっと小さくなります。ポンドは主要通貨のなかでも値動きが大きい部類です。'
      + '計算は {{app}} に任せて、このページではポンドと円という組み合わせの読み方を見ていきます。',
    h2: 'ポンド円を調べているのはどんな人か',
    body: [
      'ポンド円（GBP/JPY）は、ロンドンへの旅行、イギリスへの語学留学や大学進学、英国のオンラインショップでの買い物で使われます。学費や寮費のように金額が大きい支払いでは、送る日のレートの差がそのまま負担の差になり、旅行者とは桁のちがう関心の持ち方になります。',
      '日本の個人投資家のあいだで、ポンド円は値動きの荒さから長く「殺人通貨」と呼ばれてきました。実際、主要通貨のなかでも一日の値幅が大きくなりやすいペアです。留学費用のように何か月も先に支払う予定があるなら、一度にまとめて替えるか、何回かに分けるかで結果が変わります。',
      'イギリスの小売価格には付加価値税が含まれているため、値札の金額をそのまま円に直せば支払額になります。またスコットランドと北アイルランドの銀行は独自の紙幣を発行していますが、同じポンドであり、レートも同じです。ポンドは100ペンスに分かれ ISO 4217 の指数は 2 ですが、円には補助単位がないので、換算結果は整数で表示されます。',
      'ロンドンの地下鉄やバスは、手持ちのカードをそのままかざして乗る方式が定着しています。運賃はポンドで記録され、円への換算はカード会社が行うため、明細に出てくる円の金額を決めるのは乗った日ではなく、決済が処理された日の水準です。',
    ],
    tips: {
      h3: 'ポンド円で気をつけること',
      items: [
        'イギリスの値札は付加価値税込みで、表示額がそのまま支払額になります。',
        'スコットランドや北アイルランドの銀行券も同じポンドで、レートは変わりません。',
        '学費のような大きな支払いは、送金を実行した日のレートで金額が確定します。',
        'ポンド円は値幅が大きくなりやすいので、直前だけでなく数日前から見ておくと判断しやすくなります。',
        '{{app}} でポンド円をお気に入りに入れておけば、開いた瞬間に水準を確認できます。',
      ],
    },
    faq: [
      {
        q: 'イギリス留学の学費は、いつのレートで円になりますか。',
        a: '送金や決済を実行した日のレートで確定します。請求書に書かれたポンドの金額が変わらなくても、用意すべき円の金額は送る日によって変わります。締切まで余裕がある場合、何回かに分けて送ることで一度の水準に賭けずに済みます。',
      },
      {
        q: 'スコットランドの紙幣は、イングランドの紙幣と価値が違いますか。',
        a: '同じ価値です。発行する銀行が違うだけで、どちらも同じポンドであり、換算レートも同一です。イングランドの店で受け取りを渋られる例はありますが、それは見慣れているかどうかの問題で、両替が必要になるわけではありません。',
      },
    ],
  },

  'vnd-jpy': {
    lead:
      'ベトナムドン（VND）を日本円（JPY）に換算すると、桁が大きく減ります。ドンには補助単位がなく、日常の価格が数万から数十万の整数になるためです。'
      + '桁の多い金額は無料の {{app}} に入力するのが確実です。以下は、ドンと円のあいだで何が起きているかの説明です。',
    h2: 'ドン円を調べているのはどんな人か',
    body: [
      'ドン円（VND/JPY）を見ているのは、ハノイやホーチミン、ダナンへ旅行する人だけではありません。日本で働くベトナムの人たちが、家族へ送るお金の受取額を確かめる数字でもあります。日本に暮らすベトナムの人は在留外国人のなかでも最大級の規模で、この方向の関心は旅行者よりずっと大きくなっています。',
      '送金では、参考レートと送金業者が提示するレートの差が、実質的な手数料になります。表示されている送金手数料だけを見ても本当の負担は分かりません。送る前に参考レートを確かめ、業者の提示レートとの開きを見ておくと、同じ金額を送っても受け取れるドンが変わることが分かります。',
      'ドンは ISO 4217 の指数が 0 で、補助単位がありません。値段は「50k」のように千の位を省いて書かれることが多く、この場合は五万ドンを意味します。高額の紙幣はポリマー製で、色や大きさが似ているものがあり、桁をひとつ間違えると十倍払ってしまいます。ベトナム国家銀行がドンを細かく管理しているため値動きは緩やかですが、両替所や銀行が上乗せする幅のほうが場所によって大きく開きます。',
      '紙幣で額面がいちばん大きいのは50万ドン札です。小さな店で出すと釣り銭が足りないことがあり、受け取りを断られる場面もあります。両替のときに小額紙幣を混ぜてもらっておくと、屋台や市場、短距離の移動での支払いがずいぶん楽になります。',
    ],
    tips: {
      h3: 'ドン円で気をつけること',
      items: [
        '「50k」という表記は五万ドンを意味し、千の位が省略されています。',
        'ドンには補助単位がないため、換算結果は常に整数です。',
        '送金は手数料の表示額だけでなく、提示レートと参考レートの開きも合わせて比べます。',
        '紙幣は色が似ているものがあるので、支払う前に桁を確認します。',
        '市場や地方で電波が届かないときも、{{app}} は保存済みのレートで換算します。',
      ],
    },
    faq: [
      {
        q: 'ベトナムの値段に出てくる「k」は何ですか。',
        a: '千を意味する省略表記です。「50k」は五万ドンを指し、屋台のメニューや市場の値札で広く使われています。{{app}} には、省略しない金額を入力してください。',
      },
      {
        q: '日本からベトナムへの送金で、受取額を増やすにはどうすればいいですか。',
        a: '送金業者が提示するレートには、すでに業者の取り分が含まれています。参考レートとの開きに固定手数料を足したものが、実際の負担です。少額を何度も送るより、まとめて送るほうが1回あたりの固定費が薄まり、受取額が増えることがよくあります。',
      },
    ],
  },

  'php-jpy': {
    lead:
      'フィリピンペソ（PHP）を日本円（JPY）に換算すると、ペソの数字は円より小さくなります。ペソは100センタボに分かれます。'
      + '換算そのものは無料の {{app}} が引き受けます。扱うのは、ペソと円をやり取りする人たちの事情です。',
    h2: 'ペソ円を調べているのはどんな人か',
    body: [
      'ペソ円（PHP/JPY）は、セブ島やマニラでの語学留学、リゾート旅行、そして日本で働くフィリピンの人たちの本国送金で使われます。語学学校の授業料や滞在費はペソまたは米ドルで示されることが多いので、どちらの通貨の見積もりなのかを確かめてから円に直さないと、予算が合わなくなります。',
      'フィリピンへの送金は世界でも大きな流れのひとつで、日本からの送金も給料日の周期に合わせて動きます。受け取り方法は銀行口座への入金、現金の受け取り、電子ウォレットへのチャージなど複数あり、同じ業者でも方法によってレートと手数料の組み合わせが違うことがあります。比べるべきは宣伝されている手数料ではなく、最終的に相手が受け取るペソの金額です。',
      '週末は銀行間市場が閉じているため、送金業者は金曜までの水準をもとにレートを出し、月曜の変動に備えて上乗せを広めに取ることがあります。急ぎでなければ平日に送るほうが条件が良くなりやすいのは、このためです。フィリピンの地方では通信が不安定な場所も残っており、現地で値段を確かめるときには通信なしで換算できると助かります。',
      'フィリピンペソの記号は日本ではあまり見かけない形をしています。見積書に金額と記号だけが並んでいると、米ドル建てなのかペソ建てなのか判断できないことがあり、語学学校の請求ではこれが実際に起こります。通貨コードの PHP が明記されているかを確かめ、なければ先に問い合わせたほうが確実です。',
    ],
    tips: {
      h3: 'ペソ円で気をつけること',
      items: [
        '受取額は、提示レートと固定手数料の両方を合わせて比べます。',
        '銀行入金と現金受け取りでは、同じ業者でもレートが違うことがあります。',
        '週末は銀行間市場が閉じるため、送金業者の上乗せが広がりやすくなります。',
        '語学学校の見積もりはペソか米ドルのことが多いので、どちらの通貨かを確かめます。',
        '通信の弱い地域では、{{app}} が保存済みのレートで換算を続けます。',
      ],
    },
    faq: [
      {
        q: '週末に送金すると、ペソの受取額は変わりますか。',
        a: '変わることがあります。土日は銀行間市場が動いていないため、送金業者は直近の水準をもとにレートを決め、月曜に動く可能性を見込んで上乗せを広げる場合があります。急ぎでなければ、平日に送るほうが有利になりやすいです。',
      },
      {
        q: '現金の受け取りと銀行への入金では、どちらが有利ですか。',
        a: '業者によります。同じ会社でも受け取り方法ごとにレートと手数料の組み合わせが違うことがあるため、宣伝されているレートではなく、相手が最終的に受け取るペソの金額で比べてください。',
      },
    ],
  },

  'aud-jpy': {
    lead:
      'オーストラリアドル（AUD）を日本円（JPY）に換算すると、豪ドルの数字は円よりずっと小さくなります。豪ドルは資源価格に反応しやすい通貨です。'
      + '数字を出すのは {{app}} で、圏外の多い土地でも保存したレートで動きます。ここでは豪ドルと円の特徴を説明します。',
    h2: '豪ドル円を調べているのはどんな人か',
    body: [
      '豪ドル円（AUD/JPY）は、ワーキングホリデーや語学留学でオーストラリアに滞在する人が、まずお気に入りに登録するペアです。家賃、シェアハウスの分担金、時給や週給を円に直して家族に伝えたり、日本に残した口座からの仕送りを計算したりする場面で使われます。滞在が長いほど、替える時期を分ける人が増えます。',
      'オーストラリアの表示価格には物品サービス税が含まれています。飲食店でチップを渡す習慣もありません。したがって、メニューや値札の金額をそのまま円に換算すれば、実際に払う金額になります。税抜表示でチップも乗るアメリカとは、ここが大きく違います。',
      '豪ドルは鉄鉱石や石炭などの資源輸出に支えられた通貨で、資源需要やアジア向けの輸出が話題になると、国内の経済指標より先に動くことがあります。日本の個人投資家のあいだでは金利差を狙って買われることの多いペアでもあり、そのぶん円高の局面では下げ方も大きくなりがちです。内陸部では通信の届かない区間が長く続くため、滞在中に電波のない場所で値段を確かめる機会も思うより多くあります。',
      '硬貨にも独特の決まりがあります。1セントと2セントの硬貨はすでに廃止されており、現金で支払うときは合計額が5セント単位に丸められます。カードで払えば表示どおりの金額です。わずかな差ですが、レシートの合計と値札を足した金額が一致しない理由はここにあります。',
    ],
    tips: {
      h3: '豪ドル円で気をつけること',
      items: [
        '表示価格には物品サービス税が含まれ、チップの習慣もないため、値札がそのまま支払額です。',
        '時給や週給は税引き前で示されることが多く、円に直すときは手取りと区別します。',
        '資源需要の話題で動きやすく、国内の経済指標より先に反応することがあります。',
        '長距離移動では圏外が続くため、{{app}} に保存したレートが役に立ちます。',
        '滞在が長いほど、まとめて替えるより時期を分ける人が多くなります。',
      ],
    },
    faq: [
      {
        q: 'オーストラリアの値札は税込ですか。',
        a: '税込です。物品サービス税は表示価格に含まれているため、値札やメニューの金額をそのまま円に換算すれば、支払う金額になります。チップの習慣もないので、上乗せを見込む必要はありません。',
      },
      {
        q: '豪ドルが資源価格で動くと言われるのはなぜですか。',
        a: 'オーストラリアの輸出は鉄鉱石や石炭など資源の比重が大きく、その需要が通貨そのものの需要につながりやすいためです。あくまで傾向であり、金融政策の変更が出れば、そちらが値動きを左右します。',
      },
    ],
  },

  'hkd-jpy': {
    lead:
      '香港ドル（HKD）を日本円（JPY）に換算すると、香港ドルの数字は円よりかなり小さくなります。香港ドルは米ドルに連動する仕組みのため、円に対しては米ドルとよく似た動き方をします。',
    h2: '香港ドル円を調べているのはどんな人か',
    body: [
      '香港ドル円（HKD/JPY）は、週末の香港旅行、乗り継ぎでの滞在、香港経由の輸入や取引で使われます。距離が近く日程が短いぶん、両替の手間や上乗せ分が旅費に占める割合は大きくなりやすい行き先です。',
      '香港ドルの特徴は、米ドルとの連動制度が1983年から続いている点にあります。現在は香港金融管理局がこの制度を運用し、定められた狭い範囲に収まるよう管理しているため、この幅から大きく外れることはありません。その結果、香港ドル円のチャートはドル円のチャートとよく似た形になります。香港側の材料より、米ドルと円の関係のほうが効いてくるということです。',
      'ここで実際に効いてくるのは、制度そのものではなく上乗せ幅です。連動制度があっても手にする金額が一定になるわけではなく、両替所、銀行、カード会社が乗せる手数料は窓口ごとに違います。参考レートを先に見ておくと、その差が見えます。なお香港の紙幣は、香港上海銀行、スタンダードチャータード銀行、中国銀行（香港）という三つの発券銀行が発行しており、10香港ドル札だけは政府が出しています。デザインが何種類あっても、同じ香港ドルであることに変わりはありません。',
      'マカオへ足を延ばす場合はもうひとつ注意点があります。マカオの多くの店は香港ドルをそのまま受け取りますが、マカオの通貨はパタカという別のお金で、おつりがパタカで返ってくることがあります。パタカは香港では使えないので、戻る前に使い切るか両替しておくほうが無駄になりません。',
    ],
    tips: {
      h3: '香港ドル円で気をつけること',
      items: [
        '香港ドルは米ドルに連動しているため、円に対する動きはドル円とよく似ます。',
        '連動制度があっても、両替所やカード会社の上乗せは窓口ごとに違います。',
        '紙幣は三つの発券銀行が出しており、デザインが違っても同じ香港ドルです。',
        '交通機関や売店では IC カードが広く使え、香港ドルでチャージします。',
        '短い滞在では、必要な分だけ替えて残りはカードで払う人が多いです。',
      ],
    },
    faq: [
      {
        q: '香港ドルは米ドルに固定されているのですか。',
        a: '1983年から米ドルとの連動制度が続いており、いまは香港金融管理局のもとで、定められた狭い範囲に収まるよう管理されています。完全な固定ではなく幅のある制度ですが、動く余地は小さく、日本円との関係は米ドルと円の動きに強く左右されます。',
      },
      {
        q: '香港の紙幣はデザインがいくつもありますが、どれも同じように使えますか。',
        a: '同じように使えます。香港上海銀行、スタンダードチャータード銀行、中国銀行（香港）という三つの発券銀行がそれぞれ紙幣を発行しているため、同じ額面でも見た目が違います。いずれも同じ香港ドルで、価値も換算レートも変わりません。',
      },
    ],
  },

  'sgd-jpy': {
    lead:
      'シンガポールドル（SGD）を日本円（JPY）に換算すると、シンガポールドルの数字は円よりかなり小さくなります。物価の水準が高いので、桁の感覚に慣れが必要です。'
      + '換算は無料の {{app}} に任せ、この先では現地で知っておきたい点を挙げます。',
    h2: 'シンガポールドル円を調べているのはどんな人か',
    body: [
      'シンガポールドル円（SGD/JPY）は、出張、駐在、乗り継ぎでの滞在、そして東南アジアに拠点を置く取引で使われます。ホテルと外食の水準が高い都市なので、日本の感覚のまま予算を組むと足りなくなりがちです。会食や宿泊の見積もりは、現地通貨のまま受け取って円に直すほうが確実です。',
      'シンガポールの金融政策は、多くの国と違って政策金利ではなく為替相場を動かす仕組みになっています。シンガポール金融管理局は、自国通貨を貿易加重の通貨バスケットに対して緩やかな幅のなかで誘導しており、金利のほうは市場に委ねられます。値動きが比較的落ち着いて見えるのは、この設計によるところがあります。',
      'もうひとつ知っておくと便利なのが、ブルネイドルとの等価交換の取り決めです。1967年から続く協定により、シンガポールとブルネイは互いの通貨を等価で受け入れています。シンガポールの店でブルネイドルの紙幣を渡されることがあるのはこのためで、驚く必要はありません。飲食店では料金にサービス料と税が加わることがあり、メニューの端の小さな注記が実際の支払額を左右します。',
      '外食の水準が高い一方で、ホーカーセンターと呼ばれる屋台街だけは例外的に安く、滞在中の食費を大きく左右します。ここは現金や国内向けの決済手段が中心の店も残っているため、少額のシンガポールドルを持っておくと使い勝手が良くなります。宿泊費との落差が大きいので、予算は項目ごとに分けて換算したほうが実態に合います。',
    ],
    tips: {
      h3: 'シンガポールドル円で気をつけること',
      items: [
        '飲食店ではサービス料と税が加算されることがあり、メニューの注記を確認します。',
        '金融政策が金利ではなく為替相場で運営されているため、値動きの理由が他国と異なります。',
        'ブルネイドルはシンガポール国内で等価のまま通用します。',
        '乗り継ぎだけの滞在なら、両替せずカード払いで済ませる人が多いです。',
        '{{app}} は通信がなくても、最後に保存したレートで換算できます。',
      ],
    },
    faq: [
      {
        q: 'シンガポールの中央銀行は金利を動かさないのですか。',
        a: 'シンガポール金融管理局は、政策金利ではなく自国通貨の対バスケット相場を政策手段としています。通貨の推移に幅を設けて誘導する方式で、金利は市場で決まります。そのため、他国の中央銀行の金利発表と同じ感覚では読み解けません。',
      },
      {
        q: 'ブルネイドルはシンガポールで使えますか。',
        a: '使えます。1967年の通貨等価交換の協定により、シンガポールとブルネイは互いの通貨を等価で受け入れています。おつりにブルネイドルの紙幣が混ざることもありますが、そのままシンガポール国内で使えます。',
      },
    ],
  },
},

  ko: {
  'usd-krw': {
    lead:
      '미국 달러(USD)를 대한민국 원(KRW)으로 환산하면 소수점이 없는 정수 금액이 나옵니다. 원화에는 유통되는 보조 단위가 없기 때문입니다. '
      + '환산 자체는 {{app}}가 맡고, 마지막으로 내려받은 환율을 기기에 저장해 두기 때문에 통신이 끊긴 곳에서도 그대로 계산됩니다.',
    h2: '달러 원화 환율을 들여다보는 사람들',
    body: [
      '국내에서 가장 많이 조회되는 통화 조합입니다. 미국 쇼핑몰 직구 결제, 유학 자녀 학비 송금, 해외 주식 계좌 입출금, 여행 경비 환전이 모두 이 숫자 하나에서 출발합니다. 서울 외환시장은 2024년 7월부터 오전 9시에 열어 다음 날 새벽 2시에 닫도록 거래 시간이 늘어났고, 덕분에 런던 시장이 문을 닫을 때까지 국내에서 가격이 형성됩니다. 원화는 역외에서 자유롭게 거래되지 않아, 해외 시장에서는 실물 인도 없이 차액만 정산하는 선물환으로 거래됩니다.',
      '은행 고시표에는 숫자가 최소 세 개 찍힙니다. 매매기준율, 현찰 살 때 값, 현찰 팔 때 값입니다. {{app}}가 보여 주는 것은 은행 간 거래에 가까운 참고 환율이고, 창구에서 현찰을 받을 때 적용되는 값은 그 위에 은행 마진이 얹힌 결과입니다. 흔히 말하는 "환전 우대 90퍼센트"는 기준환율을 깎아 준다는 뜻이 아니라 그 마진을 90퍼센트 덜 떼겠다는 뜻입니다. 우대율만 놓고 비교하면 원래 마진이 넓은 곳이 오히려 싸 보이는 착시가 생깁니다.',
      '직구 쪽에서는 한 건에 서로 다른 시점의 환율이 최소 두 개 관여합니다. 카드 청구액은 카드사가 해외 매입 전표를 정산하는 날의 환율로 정해지고, 관세와 부가세는 관세청이 주 단위로 고시해 그 주 내내 고정해 두는 과세환율로 계산됩니다. 미국에서 들어오는 특송화물의 목록통관 면세 한도는 미화 200달러로, 다른 나라에 적용되는 150달러보다 높다는 점도 함께 기억해 둘 만합니다.',
    ],
    tips: {
      h3: '달러를 원화로 옮기기 전에 확인할 것',
      items: [
        '고시표의 매매기준율과 현찰 살 때 값은 다른 숫자입니다. 비교는 기준율끼리 하세요.',
        '환전 우대율은 기준환율이 아니라 은행 마진에 적용되는 할인입니다.',
        '해외 가맹점에서 원화 결제를 고르면 수수료가 한 겹 더 붙습니다. 카드사에 해외 원화 결제 차단을 미리 걸어 두면 선택 자체가 뜨지 않습니다.',
        '직구 관부가세는 결제일 환율이 아니라 그 주에 고정된 과세환율로 계산됩니다.',
        '{{app}}에서 이 조합을 즐겨찾기로 고정해 두면 열자마자 맨 위에 보입니다.',
      ],
    },
    faq: [
      {
        q: '환전 우대율 90퍼센트는 환율을 90퍼센트 깎아 준다는 뜻인가요?',
        a: '아닙니다. 우대는 매매기준율과 현찰 환율 사이에 놓인 은행 마진에만 적용됩니다. 우대율이 높아도 원래 마진 폭이 넓으면 최종 금액은 불리할 수 있으므로, 같은 금액을 바꿨을 때 실제로 받는 총액끼리 비교하는 편이 정확합니다.',
      },
      {
        q: '직구 카드 청구액이 주문할 때 계산한 금액과 다른 이유는 무엇인가요?',
        a: '카드 청구에 쓰이는 환율은 주문일이 아니라 카드사가 해외 매입 전표를 정산하는 날의 값입니다. 관세와 부가세는 또 다른 기준인 관세청 주간 과세환율로 계산되므로, 한 건의 직구에 시점이 다른 환율이 여러 개 끼어듭니다.',
      },
    ],
  },

  'jpy-krw': {
    lead:
      '일본 엔(JPY)을 대한민국 원(KRW)으로 환산하면 두 통화 모두 보조 단위가 없어 결과는 언제나 정수입니다. '
      + '여기에 국내 고시환율이 1엔이 아니라 100엔을 묶어 표시하는 관행이 겹쳐 자릿수를 놓치기 쉽습니다. {{app}}가 쓰는 기준은 100엔이 아니라 1엔입니다.',
    h2: '엔화 환율을 늘 켜 두는 사람들',
    body: [
      '일본은 한국에서 출발하는 노선이 가장 촘촘한 여행지입니다. 도쿄와 오사카, 후쿠오카는 주말 이틀 일정이 성립할 만큼 가깝고, 그래서 엔 환율은 항공권 예약 화면 옆에서 늘 같이 조회됩니다. 여기에 라쿠텐과 메르카리, 아마존 재팬에서 물건을 담는 직구족, 캐릭터 굿즈와 중고 카메라를 사 모으는 수집가, 일본 거래처를 상대하는 실무자까지 같은 숫자를 봅니다.',
      '가장 자주 나오는 실수는 100엔 표기입니다. 국내 은행 고시표와 경제 뉴스는 "100엔당 원"으로 적는데, 현지 가격표는 당연히 1엔 단위로 붙어 있습니다. 고시 숫자를 가격표에 그대로 곱하면 결과가 백 배로 부풀어 오릅니다. {{app}}는 1엔을 기준으로 삼으므로, 고시환율과 견주려면 고시된 값을 100으로 나눈 뒤 비교하면 맞아떨어집니다.',
      '엔은 정책 방향이 다른 주요 통화들과 오래 어긋나 있었던 탓에 몇 년 단위로 보면 진폭이 큰 편입니다. 같은 예산으로 짜는 여행 경비가 해마다 눈에 띄게 달라지는 이유입니다. 현장에서는 현금 비중이 여전히 높아 편의점 ATM이 외국 카드에 가장 무난하고, 방문객 면세는 한 매장에서 5,000엔 이상 살 때부터 적용됩니다. 면세 처리는 엔화로 끝난 뒤 카드 환율이 그 위에 붙습니다.',
    ],
    tips: {
      h3: '엔화를 바꾸기 전에 알아 둘 것',
      items: [
        '국내 고시환율은 100엔 단위, 현지 가격표는 1엔 단위입니다. 두 숫자를 섞지 마세요.',
        '엔에는 유통되는 보조 단위가 없어 환산 결과에 소수점이 붙지 않습니다.',
        '방문객 면세는 한 매장 5,000엔 이상 구매에 적용되며 계산은 엔화로 마무리됩니다.',
        '지하철과 지하상가에서는 데이터가 자주 끊기니 오프라인 환산이 실제로 쓸모 있습니다.',
        '출국 전에 {{app}}를 한 번 열어 환율을 갱신해 두면 여행 내내 저장된 값으로 계산됩니다.',
      ],
    },
    faq: [
      {
        q: '국내 뉴스에 나오는 엔 환율은 왜 100엔 기준인가요?',
        a: '엔은 1엔당 금액이 작아 고시표에서 100엔을 묶어 표시하는 관행이 굳어졌습니다. {{app}}는 1엔을 기준으로 환산하므로, 100엔당으로 고시된 값과 비교하려면 그 숫자를 100으로 나눈 뒤 견주면 됩니다.',
      },
      {
        q: '엔화는 한국에서 바꾸는 게 나은가요, 일본에서 바꾸는 게 나은가요?',
        a: '유불리는 환율보다 마진에서 갈립니다. 국내 주거래 은행의 우대 조건과 일본 현지 환전소, 편의점 ATM 수수료를 각각 원화 총액으로 환산해 견줘 보세요. 어느 나라에서든 공항 환전 창구의 마진이 가장 넓다는 점은 공통입니다.',
      },
    ],
  },

  'eur-krw': {
    lead:
      '유로(EUR)를 대한민국 원(KRW)으로 환산하면 유로존 20개국 이상에서 통하는 가격 하나가 원화 금액 하나로 정리됩니다. 국경을 넘어도 환율은 그대로라는 뜻입니다. '
      + '금액을 원화로 옮기는 일은 {{app}}가 처리하고, 국경을 넘어 연결이 끊긴 구간에서도 저장된 환율로 이어집니다.',
    h2: '유로가 필요해지는 순간',
    body: [
      '유럽 일정은 나라를 여러 번 옮겨도 환율은 하나로 유지됩니다. 파리에서 로마로, 다시 암스테르담으로 넘어가는 동안 유로를 쓰는 구간에서는 이 조합 하나만 보면 됩니다. 반대로 스위스와 체코, 폴란드, 헝가리처럼 유로존 밖에 있는 나라에서는 각자의 통화가 따로 있으니 환율도 따로 챙겨야 합니다. 유럽 브랜드 직구와 구매대행 견적, 명품 정가 비교도 모두 유로로 매겨진 가격에서 시작합니다.',
      '유럽 매장 결제에서 가장 큰 손실은 환율이 아니라 결제 통화를 고르는 순간에 발생합니다. 단말기가 원화로 결제하겠느냐고 물을 때 원화를 고르면 가맹점 쪽이 지정한 환전 서비스가 자기 환율로 먼저 바꾼 뒤 청구하므로 수수료가 이중으로 붙습니다. 현지 통화로 결제하고 원화 환산은 카드사에 맡기는 쪽이 참고 환율에 훨씬 가깝습니다.',
      '부가세 환급도 유로 기준으로 굴러갑니다. 매장에서 받은 환급 서류에 적힌 금액은 유로이고, 실제로 돌아오는 돈은 환급 대행사 수수료를 뺀 나머지가 카드 환율을 거쳐 원화가 됩니다. 서류의 유로 금액을 {{app}}에 넣어 보면 돌려받을 수 있는 금액의 상한선을 미리 가늠할 수 있습니다. 공항 현금 환급 창구는 즉시 받는 대신 수수료가 더 붙는 쪽입니다.',
    ],
    tips: {
      h3: '유럽 결제와 환급에서 챙길 것',
      items: [
        '유럽 카드 단말기가 원화 결제를 권하면 거절하고 현지 통화로 결제하세요.',
        '유럽 표시가격에는 부가세가 이미 포함되어 있어 계산대에서 금액이 늘지 않습니다.',
        '스위스, 체코, 폴란드, 헝가리는 유로존이 아니라 각자의 통화를 씁니다.',
        '환급 서류의 유로 금액은 대행사 수수료를 뺀 뒤에야 원화로 들어옵니다.',
        '{{app}}에서 여러 통화를 한 화면에 띄워 두면 국경을 넘을 때마다 통화를 바꿔 넣지 않아도 됩니다.',
      ],
    },
    faq: [
      {
        q: '유럽에서 카드를 쓸 때 원화와 현지 통화 중 무엇을 골라야 하나요?',
        a: '현지 통화입니다. 원화를 고르면 가맹점이 정한 환전 업체가 자체 환율을 적용한 뒤 청구하므로 카드사 환율보다 불리한 경우가 대부분입니다. 카드사에 해외 원화 결제 차단을 신청해 두면 그 선택지 자체가 나타나지 않습니다.',
      },
      {
        q: '부가세 환급을 받으면 서류에 적힌 유로 금액이 그대로 돌아오나요?',
        a: '아닙니다. 서류 금액에서 환급 대행사 수수료가 먼저 빠지고, 남은 유로가 카드사나 현금 환급 창구의 환율을 거쳐 원화가 됩니다. 공항에서 현금으로 즉시 받는 쪽은 수수료가 더 붙는 것이 보통입니다.',
      },
    ],
  },

  'vnd-krw': {
    lead:
      '베트남 동(VND)을 대한민국 원(KRW)으로 환산하면 자릿수가 크게 줄어듭니다. 두 통화 모두 보조 단위가 없어 결과는 정수지만, 동 쪽 숫자가 훨씬 길어 0을 세는 일이 사실상 전부입니다. '
      + '{{app}}는 신호가 없는 시장 한복판에서도 저장된 환율로 계산합니다.',
    h2: '동 환율을 매일 확인하는 사람들',
    body: [
      '다낭과 나트랑, 푸꾸옥 노선이 늘면서 베트남은 가장 가까운 동남아 목적지 가운데 하나가 됐습니다. 여기에 현지 법인으로 나간 주재원, 하노이와 호찌민의 생산 기지를 관리하는 실무자, 국내에 체류하며 본국 가족에게 돈을 부치는 베트남 노동자와 결혼 이주민까지 더해집니다. 이 조합이 여행 통화보다 생활 통화에 가깝게 쓰이는 이유입니다.',
      '동은 액면 단위가 커서 지폐마다 0이 길게 붙습니다. 그래서 손에 쥔 지폐의 액면을 한 자리 잘못 읽는 일이 흔하고, 메뉴판과 시장 간판은 천 단위를 아예 생략해 적는 경우가 많습니다. 가격 옆에 k가 붙어 있으면 천을 곱하라는 표시입니다. 이 조합에서 생기는 실수의 대부분은 환율을 잘못 봐서가 아니라 0을 하나 더 세거나 덜 센 데서 나옵니다.',
      '국내에서 원화를 동으로 바로 바꾸는 대신 달러로 한 번 바꾼 뒤 현지에서 다시 동으로 바꾸는 이중 환전이 오래 퍼져 있었습니다. 어느 쪽이 유리한지는 그때그때 마진에 달렸는데, 판단하려면 원화 대비 동의 참고 환율을 먼저 알고 있어야 합니다. 두 경로의 최종 금액을 같은 기준선에 놓고 비교하는 것이 핵심이고, 그 기준선이 되는 참고 환율은 {{app}}에 떠 있습니다.',
    ],
    tips: {
      h3: '동 환산에서 실수를 줄이는 법',
      items: [
        '가격표의 k는 천 동을 뜻합니다. 50k라고 적혀 있으면 5만 동입니다.',
        '동에는 유통되는 보조 단위가 없어 환산 결과에 소수점이 나오지 않습니다.',
        '지폐를 건네기 전에 액면에 붙은 0의 개수를 한 번 더 세세요. 한 자리 차이가 열 배입니다.',
        '공항 도착장 창구보다 시내 은행 지점과 금은방 쪽 마진이 좁은 편이지만 업체별 편차가 큽니다.',
        '{{app}}는 저장해 둔 환율로 작동하므로 시장이나 해변에서 신호가 없어도 계산됩니다.',
      ],
    },
    faq: [
      {
        q: '메뉴판에 적힌 100k는 얼마인가요?',
        a: '100k는 10만 동을 줄여 쓴 표기입니다. {{app}}에 100000을 넣으면 그 시점의 원화 금액이 나옵니다. 베트남에서는 천 단위를 생략하는 표기가 일반적이므로, 숫자 뒤에 k가 보이면 천을 곱해 두는 습관이 안전합니다.',
      },
      {
        q: '원화를 달러로 바꿨다가 다시 동으로 바꾸는 편이 유리한가요?',
        a: '항상 그렇지는 않습니다. 두 번 바꾸면 마진도 두 번 붙기 때문에, 국내에서 동으로 바로 바꿀 때의 마진이 좁다면 직접 환전이 낫습니다. {{app}}가 보여 주는 참고 환율을 기준으로 각 경로에서 최종적으로 손에 들어오는 금액을 견줘 보세요.',
      },
    ],
  },

  'cny-krw': {
    lead:
      '중국 위안(CNY)을 대한민국 원(KRW)으로 환산하면 위안 금액에 환율을 곱한 원화가 나오는데, 기준이 되는 것은 본토에서 관리되는 위안입니다. '
      + '화폐 자체의 이름은 인민폐이고 금액을 세는 단위가 위안입니다. {{app}}는 본토에서 거래되는 CNY를 기준으로 환산합니다.',
    h2: '위안 환율이 쓰이는 자리',
    body: [
      '알리익스프레스와 타오바오 같은 플랫폼이 자리를 잡으면서 위안으로 매겨진 가격을 원화로 바꿔 보는 일이 일상이 됐습니다. 구매대행과 소싱, 중국 공장을 끼고 일하는 소상공인에게는 이 환율이 원가표의 첫 줄이기도 합니다. 상하이와 칭다오로 오가는 출장, 중국 대학에 다니는 유학생의 학비와 생활비도 같은 숫자를 거칩니다.',
      '이름부터 정리하면 혼란이 줄어듭니다. 화폐의 이름은 인민폐이고, 금액을 세는 단위가 위안이며, 구어에서는 콰이라고 부릅니다. 더 중요한 것은 환율이 하나가 아니라는 점입니다. 본토에서 거래되는 쪽은 중국인민은행이 매일 기준가를 정하고 그 위아래 정해진 폭 안에서만 움직입니다. 홍콩에서 거래되는 역외 위안은 제약이 덜해 상대적으로 자유롭게 움직입니다. 두 값은 대체로 가깝지만 같지는 않습니다.',
      '실무에서는 이 차이가 견적과 정산 금액의 차이로 나타납니다. 공급업체가 어느 쪽을 보고 견적을 냈느냐에 따라 같은 날 같은 물건의 원화 환산액이 달라질 수 있으니, 계약서에 기준 환율의 출처와 적용 시점을 적어 두는 편이 안전합니다. 알리페이와 위챗페이로 결제하면 정산은 위안으로 끝나고, 원화 청구액은 카드사가 매입을 정리하는 날 확정됩니다.',
    ],
    tips: {
      h3: '위안 환산에서 짚어야 할 것',
      items: [
        '인민폐는 화폐의 이름, 위안은 세는 단위입니다. 둘은 같은 돈을 가리킵니다.',
        '본토 환율과 홍콩 역외 환율은 별개입니다. 견적서가 어느 쪽인지 확인하세요.',
        '알리페이와 위챗페이는 위안으로 정산되므로 원화 청구액은 결제일 이후에 확정됩니다.',
        '위안은 소수점 두 자리를 쓰지만 원화는 정수라 환산 결과에서 반올림이 일어납니다.',
        '{{app}}의 1일부터 5년까지 차트를 보면 본토 환율이 얼마나 좁게 관리되는지 눈에 들어옵니다.',
      ],
    },
    faq: [
      {
        q: '본토 위안과 홍콩 역외 위안은 무엇이 다른가요?',
        a: '본토에서 거래되는 위안은 중국인민은행이 매일 정하는 기준가를 중심으로 정해진 범위 안에서만 움직입니다. 홍콩에서 거래되는 역외 위안은 그런 제약이 덜해 더 자유롭게 움직입니다. 두 환율은 보통 비슷한 수준이지만 완전히 일치하지는 않습니다.',
      },
      {
        q: '인민폐와 위안 중 어느 쪽이 맞는 표현인가요?',
        a: '둘 다 맞지만 쓰임이 다릅니다. 인민폐는 통화의 이름이고 위안은 금액을 세는 단위여서, "100위안"은 자연스럽지만 "100인민폐"는 어색합니다. ISO 4217 코드로는 본토에서 거래되는 위안을 CNY로 적습니다.',
      },
    ],
  },

  'thb-krw': {
    lead:
      '태국 바트(THB)를 대한민국 원(KRW)으로 환산하면 바트 금액에 환율을 곱한 정수 원화가 나옵니다. 바트에는 사탕이라는 보조 단위가 있지만 현금 거래에서는 대부분 바트 단위로 반올림합니다. '
      + '바트 숫자를 원화로 옮기는 쪽은 {{app}}이고, 저장해 둔 환율 덕분에 신호가 잡히지 않는 섬에서도 그대로 작동합니다.',
    h2: '바트를 자주 세는 사람들',
    body: [
      '방콕과 치앙마이, 푸껫은 직항 노선이 촘촘하고 체류 기간도 긴 편이라 한 번에 바꾸는 금액 자체가 큽니다. 여기에 한 달 살기와 골프 일정, 원격 근무로 몇 달씩 머무는 층이 겹치면서 바트는 여행 통화이자 생활비 통화가 됐습니다. 태국에서 물건을 떼어 오는 소상공인과 국내에 체류하는 태국인 노동자의 송금까지 더하면 조회 이유는 더 넓어집니다.',
      '태국은 환전 경로에 따른 조건 차이가 유난히 큰 시장입니다. 공항 도착장 창구와 시내 환전소, 은행 지점이 같은 날 서로 다른 조건을 내걸고, 지폐의 액면과 상태에 따라 조건을 달리 매기는 곳도 있습니다. 그래서 "얼마에 바꿨는지"보다 "참고 환율에서 얼마나 벌어졌는지"를 보는 편이 판단에 도움이 됩니다.',
      '결제 쪽에서는 원화 청구 권유가 자주 나옵니다. 관광지 상점과 호텔 단말기가 원화 청구를 기본값으로 잡아 두는 경우가 있으니, 영수증에 원화 금액이 찍혀 나오면 그 자리에서 현지 통화로 다시 결제해 달라고 요청하는 편이 낫습니다. 현지 ATM은 인출 한 건마다 고정 수수료가 붙는 구조라, 소액을 여러 번 뽑는 방식이 특히 불리합니다.',
    ],
    tips: {
      h3: '태국에서 돈을 바꿀 때',
      items: [
        '바트의 보조 단위는 사탕이고 100사탕이 1바트입니다. 현금 거래에서는 거의 반올림됩니다.',
        '공항 도착장보다 시내 환전소 조건이 나은 경우가 많지만 업체별 편차가 큽니다.',
        '현지 ATM은 인출 건당 고정 수수료가 붙으니 뽑는 횟수를 줄이는 편이 유리합니다.',
        '단말기가 원화 청구를 제안하면 현지 통화 결제로 바꿔 달라고 요청하세요.',
        '섬과 해변 구간은 신호가 약하니 출발 전 {{app}}로 환율을 저장해 두세요.',
      ],
    },
    faq: [
      {
        q: '현지 ATM에서 뽑는 것과 환전소에서 바꾸는 것 중 무엇이 유리한가요?',
        a: '금액에 따라 갈립니다. 현지 ATM은 인출 한 건마다 고정 수수료가 붙어 소액을 여러 번 뽑으면 불리하고, 환전소 마진은 비율로 붙어 금액이 커질수록 차이가 벌어집니다. 두 경로에서 최종적으로 손에 들어오는 현지 통화 금액을 참고 환율과 견줘 보세요.',
      },
      {
        q: '사탕 단위는 실제로 쓰이나요?',
        a: '대형 마트 가격표와 주유소 표시가에는 남아 있지만 현금 계산에서는 대체로 반올림됩니다. 카드 결제에서는 표시된 소수점 금액이 그대로 청구되므로, 현금으로 낼 때와 카드로 낼 때의 환산 결과가 조금 다를 수 있습니다.',
      },
    ],
  },

  'twd-krw': {
    lead:
      '신 타이완 달러(TWD)를 대한민국 원(KRW)으로 환산하면 대만 가격표의 元 표시 금액이 원화로 정리됩니다. 정식 기호는 NT$지만 현지 표기는 元이나 塊인 경우가 많습니다. '
      + '{{app}}에서 TWD와 CNY를 나란히 띄워 두면 같은 글자를 쓰는 두 통화가 서로 다르다는 사실이 바로 눈에 들어옵니다.',
    h2: '대만 달러가 필요한 이유',
    body: [
      '타이베이는 비행시간이 짧고 야시장, 온천, 자전거 여행처럼 목적이 뚜렷한 일정이 많아 다시 찾는 비율이 높은 목적지입니다. 여기에 반도체와 부품 업계 출장, 교환학생과 어학연수, 대만 브랜드 화장품과 차 상품을 들여오는 소규모 수입까지 더하면 이 조합은 여행보다 넓은 범위에서 조회됩니다.',
      '표기가 첫 번째 걸림돌입니다. 정식 명칭은 신 타이완 달러이고 ISO 4217 코드는 TWD, 기호는 NT$입니다. 그런데 현지 가격표와 메뉴판은 元이라고 적는 일이 흔하고, 이 글자는 중국 위안에도 그대로 쓰입니다. 대만에서 본 元을 위안으로 착각하면 환산 금액이 크게 어긋납니다. 구어에서는 塊라고 부르는 것도 함께 알아 두면 좋습니다.',
      '환전 경로도 다른 통화와 다릅니다. 국내에서 원화를 대만 달러로 곧바로 바꿔 주는 창구는 달러나 엔에 비해 취급 범위가 좁고 마진이 넓게 잡히는 편이라, 현지 은행 지점과 공항 창구를 함께 검토하는 사람이 많습니다. 다만 교통과 편의점 결제 상당 부분이 선불 교통카드로 흡수되기 때문에 실제로 필요한 현금 자체는 생각보다 적습니다.',
    ],
    tips: {
      h3: '대만 여행 전 통화 메모',
      items: [
        '대만 가격표의 元은 신 타이완 달러입니다. 같은 글자를 쓰는 중국 위안과 다른 통화입니다.',
        '기호는 NT$이고 ISO 4217 코드는 TWD입니다.',
        '선불 교통카드는 편의점과 일부 식당에서도 결제되므로 현금 인출액을 줄일 수 있습니다.',
        '야시장은 현금 위주로 돌아가니 소액권을 미리 확보해 두세요.',
        '{{app}}에 TWD를 즐겨찾기로 넣어 두면 元 표시 가격을 그 자리에서 원화로 볼 수 있습니다.',
      ],
    },
    faq: [
      {
        q: '대만 메뉴판의 元은 중국 위안과 같은 것인가요?',
        a: '다릅니다. 대만에서 쓰는 元은 신 타이완 달러를 가리키고 중국 위안은 별개의 통화입니다. 발행하는 중앙은행도 다르고 환율도 각각 따로 움직입니다. 글자만 보고 판단하지 말고 어느 나라 가격표인지부터 확인하세요.',
      },
      {
        q: '대만 달러는 국내에서 미리 바꾸는 편이 나은가요?',
        a: '취급 지점과 우대 조건에 따라 다릅니다. 대만 달러는 달러나 엔만큼 널리 취급되지 않아 국내 마진이 넓게 잡히는 경우가 있으므로, 국내 조건과 현지 은행, 공항 창구 조건을 {{app}}의 참고 환율에 각각 대 보고 정하는 편이 확실합니다.',
      },
    ],
  },

  'php-krw': {
    lead:
      '필리핀 페소(PHP)를 대한민국 원(KRW)으로 환산하면 페소 금액에 환율을 곱한 원화가 나옵니다. 페소는 100센타보로 나뉘지만 실제 계산은 페소 단위에서 끝나는 일이 많습니다. '
      + '실제 계산은 {{app}}가 맡고, 통신이 고르지 않은 지역에서도 저장해 둔 환율로 이어집니다.',
    h2: '페소가 오가는 두 방향',
    body: [
      '이 조합은 방향이 둘입니다. 한쪽에는 세부와 보라카이, 클락으로 향하는 여행객과 어학연수생, 은퇴 후 장기 체류를 택한 사람들이 있습니다. 다른 한쪽에는 국내 사업장에서 일하며 매달 본국 가족에게 돈을 부치는 필리핀 노동자와 결혼 이주민이 있습니다. 앞쪽은 현지에서 쓸 돈을 바꾸고, 뒤쪽은 국내에서 번 돈을 보냅니다.',
      '송금 쪽에서는 시점이 곧 금액입니다. 매달 비슷한 금액을 보내기 때문에 조건이 조금만 나아져도 1년 누적으로는 차이가 눈에 띕니다. 다만 송금 업체가 화면에 띄우는 환율에는 이미 마진이 들어가 있으므로, 비교 기준은 업체가 제시한 값이 아니라 그 바깥의 참고 환율이어야 합니다. 수취 방식이 계좌 입금인지 현금 수령인지에 따라 같은 업체에서도 조건이 달라집니다.',
      '여행 쪽에서는 현지 환전 경로가 다양합니다. 공항과 쇼핑몰 안 환전 창구, 은행 지점이 각각 다른 조건을 내걸고 지방으로 갈수록 폭이 넓어집니다. 리조트 안에서 외화를 직접 받아 주는 곳도 있지만 조건은 대체로 불리합니다. 지역에 따라 통신이 고르지 않다는 점도 감안해 두는 편이 좋습니다.',
    ],
    tips: {
      h3: '송금과 환전에서 확인할 것',
      items: [
        '송금 업체가 제시한 환율에서 참고 환율을 뺀 폭이 실제 비용입니다. 표시 수수료만 보지 마세요.',
        '계좌 입금과 현금 수령은 같은 업체에서도 조건이 다를 수 있습니다.',
        '주말과 공휴일에는 은행 간 시장이 닫혀 있어 마진이 넓어지는 경향이 있습니다.',
        '페소의 보조 단위는 센타보이고 100센타보가 1페소입니다.',
        '지방 이동이 많다면 {{app}}에 환율을 저장해 두고 오프라인으로 쓰세요.',
      ],
    },
    faq: [
      {
        q: '필리핀으로 송금할 때 어느 환율과 비교해야 하나요?',
        a: '업체가 화면에 띄운 값끼리 비교하면 이미 마진이 반영된 숫자끼리 견주는 셈이 됩니다. {{app}}의 참고 환율을 기준선으로 두고, 같은 금액을 보냈을 때 수취인이 실제로 받는 총액을 업체별로 비교하는 편이 정확합니다.',
      },
      {
        q: '현지에서 원화를 바로 페소로 바꿀 수 있나요?',
        a: '관광지와 대도시 환전소에서는 원화를 취급하는 곳이 늘었지만 조건은 업체마다 크게 다릅니다. 원화 취급 자체가 드문 지방으로 이동한다면 선택지가 줄어드니, 일정에 맞춰 환전 시점을 나누는 편이 안전합니다.',
      },
    ],
  },

  'gbp-krw': {
    lead:
      '영국 파운드(GBP)를 대한민국 원(KRW)으로 환산하면 파운드 금액에 환율을 곱한 정수 원화가 나옵니다. 파운드는 시장에서 늘 앞자리에 놓고 호가하는 통화라 방향을 거꾸로 읽기 쉽습니다. '
      + '{{app}}에서 두 통화의 자리를 바꿔 놓아 보면 어느 쪽이 앞인지 헷갈릴 일이 없습니다.',
    h2: '파운드를 세는 유학생과 직구족',
    body: [
      '영국은 석사 과정이 대체로 1년으로 짧아 학비와 생활비를 한 번에 크게 옮기는 일이 잦습니다. 학비 고지서는 파운드로 오고 송금은 원화 계좌에서 나가므로, 한 번에 옮기는 금액이 클수록 납부 시점의 환율이 원화 총액을 크게 갈라 놓습니다. 어학연수와 워킹홀리데이로 1년쯤 머무는 사람들도 생활비를 나눠 보내며 같은 계산을 반복합니다.',
      '쇼핑 쪽에서는 영국 브랜드 직구와 편집숍 구매가 꾸준합니다. 여기서 놓치기 쉬운 것은 세금입니다. 영국 표시가격에는 부가세가 이미 포함되어 있지만, 국내로 직배송을 받으면 영국 부가세가 빠진 금액으로 결제되는 대신 통관 단계에서 관세와 부가세가 새로 붙습니다. 화면에 뜬 파운드 가격만 환산해서는 최종 지출이 나오지 않습니다.',
      '여행자라면 알아 둘 변화가 하나 더 있습니다. 영국은 2021년부터 방문객 대상 부가세 환급 제도를 운영하지 않습니다. 유럽 대륙에서 하던 공항 환급을 영국에서 기대하면 계획이 어긋납니다. 지폐 쪽에서는 스코틀랜드와 북아일랜드 은행이 자체 도안의 파운드 지폐를 발행하지만, 같은 통화이고 환율도 같습니다.',
    ],
    tips: {
      h3: '파운드 환산에서 헷갈리는 지점',
      items: [
        '시장 호가는 파운드를 앞에 둡니다. 뉴스에 나온 숫자가 어느 방향인지 먼저 확인하세요.',
        '영국 표시가격에는 부가세가 포함되어 있어 계산대에서 금액이 늘지 않습니다.',
        '영국은 2021년부터 방문객 부가세 환급을 하지 않습니다.',
        '스코틀랜드와 북아일랜드 발행 지폐도 같은 파운드이며 가치와 환율에 차이가 없습니다.',
        '학비처럼 큰 금액은 {{app}}의 장기 차트로 최근 흐름을 본 뒤 시점을 나눠 보내는 방식이 많이 쓰입니다.',
      ],
    },
    faq: [
      {
        q: '영국 사이트에서 국내로 직배송을 받으면 부가세는 어떻게 되나요?',
        a: '영국 밖으로 나가는 주문은 영국 부가세가 빠진 금액으로 결제되는 것이 일반적입니다. 대신 국내 통관에서 관세와 부가세가 새로 부과되므로, 화면에 뜬 파운드 가격을 환산한 금액이 최종 지출은 아닙니다.',
      },
      {
        q: '스코틀랜드 지폐는 잉글랜드 지폐와 가치가 다른가요?',
        a: '같습니다. 스코틀랜드와 북아일랜드 은행이 발행하는 지폐도 동일한 파운드이고 환율도 같습니다. 도안이 달라 잉글랜드 일부 상점에서 낯설게 보는 경우가 있을 뿐, 별도의 환전이나 환산이 필요하지 않습니다.',
      },
    ],
  },

  'aud-krw': {
    lead:
      '호주 달러(AUD)를 대한민국 원(KRW)으로 환산하면 호주에서 받는 주급이나 가격표가 원화 기준으로 정리됩니다. 호주는 표시가격에 소비세가 이미 들어 있어 계산대에서 금액이 늘지 않습니다. '
      + '주급을 원화로 옮겨 보는 계산은 {{app}}가 하고, 오프라인에서도 저장된 환율로 이어집니다.',
    h2: '워킹홀리데이와 호주 달러',
    body: [
      '호주는 워킹홀리데이 참가자가 꾸준히 몰리는 나라이고, 그 뒤로 어학연수와 유학, 기술이민과 장기 체류가 이어집니다. 이들에게 이 환율은 여행 환율이 아니라 소득 환율입니다. 호주 급여는 주 단위로 들어오는 경우가 많아, 매주 통장에 찍히는 금액을 원화로 환산해 생활비 감각을 잡는 사람이 많습니다.',
      '호주 달러는 자원 수출 비중이 큰 경제를 배경으로 하는 통화라, 국내 경제지표보다 철광석과 석탄 같은 원자재 수요와 아시아 지역 경기 흐름에 더 민감하게 반응하는 경향이 있습니다. 몇 달 조용히 흐르다가 짧은 기간에 크게 움직이는 패턴이 나오는 이유입니다. 1년 넘게 머물다 돌아올 때는 출국 시점의 환율이 모아 둔 돈의 원화 총액을 사실상 결정합니다.',
      '여행자에게 실용적인 것은 두 가지입니다. 하나는 표시가격에 소비세가 포함된다는 점이고, 다른 하나는 팁 문화가 없다는 점입니다. 환산한 금액이 곧 지출 금액이라는 뜻입니다. 출국할 때 일정 조건을 갖춘 구매분에 대해 공항에서 소비세를 돌려받는 제도가 있으니 영수증을 모아 두면 도움이 됩니다.',
    ],
    tips: {
      h3: '호주에서 번 돈을 원화로 볼 때',
      items: [
        '호주 표시가격에는 소비세가 들어 있어 계산대에서 금액이 늘지 않습니다.',
        '급여가 주 단위로 들어오므로 월 기준으로 보려면 주급을 모아서 환산해야 합니다.',
        '호주 달러는 원자재 수요에 반응하는 편이라 국내 지표만으로 방향을 읽기 어렵습니다.',
        '호주는 1988년에 세계 최초로 폴리머 재질 지폐를 발행한 나라입니다.',
        '장기 체류라면 {{app}}의 5년 차트로 지금 수준이 어느 구간에 있는지 확인해 보세요.',
      ],
    },
    faq: [
      {
        q: '호주에서 번 돈은 언제 원화로 옮기는 게 좋을까요?',
        a: '정답은 없지만, 한 번에 전부 옮기는 대신 몇 차례로 나누면 특정 시점 환율에 결과가 좌우되는 정도를 줄일 수 있습니다. {{app}}의 장기 차트로 최근 몇 년 구간에서 현재 수준이 어디쯤인지 확인한 뒤 나눠 보내는 방식이 흔합니다.',
      },
      {
        q: '호주 가격표에는 세금이 포함되어 있나요?',
        a: '포함되어 있습니다. 상품과 서비스에 붙는 소비세가 표시가격 안에 들어 있어 환산한 원화 금액이 실제 결제 금액과 같습니다. 계산대에서 세금이 더해지는 미국식 표기와 다른 점입니다.',
      },
    ],
  },

  'hkd-krw': {
    lead:
      '홍콩 달러(HKD)를 대한민국 원(KRW)으로 환산할 때 실제로 움직이는 쪽은 대개 원화입니다. 홍콩 달러는 1983년부터 미국 달러에 연동되어 있고, 지금은 정해진 좁은 범위 안에서 관리되기 때문입니다. '
      + '환산도, 원화가 그동안 얼마나 움직였는지 보여 주는 장기 차트도 {{app}} 안에 있습니다.',
    h2: '달러에 묶인 통화를 원화로 볼 때',
    body: [
      '홍콩은 1983년부터 연계환율제도를 유지해 왔고, 1993년에 문을 연 홍콩금융관리국이 이 제도를 운영합니다. 2005년에 상하한이 명시되면서 지금의 밴드가 자리 잡았습니다. 값이 밴드 끝에 닿으면 당국이 직접 시장에 들어옵니다. 그래서 미국 달러 대비로 그린 차트는 거의 평평한 선에 가깝습니다.',
      '이 사실이 국내 이용자에게 뜻하는 바는 분명합니다. 이 조합의 숫자가 오르내린 것처럼 보인다면 원인은 홍콩이 아니라 대체로 미국 달러 대비 원화의 움직임입니다. 홍콩 여행 예산이나 홍콩 법인과의 정산 금액을 짤 때 달러 원화 흐름을 함께 보는 편이 상황을 훨씬 정확하게 설명해 줍니다.',
      '고정에 가깝다는 것이 비용이 고정이라는 뜻은 아닙니다. 손에 쥐는 금액을 가르는 것은 연동된 환율 위에 은행과 환전소가 얹는 마진입니다. 침사추이와 몽콕 일대 환전소, 공항 창구, 카드 결제는 똑같은 연동 환율을 두고도 서로 다른 결과를 냅니다. 지폐가 중앙은행 한 곳이 아니라 세 곳의 시중은행에서 발행되는 것도 홍콩의 특징이라, 같은 액면에 도안이 여러 가지입니다. 10홍콩달러권만은 정부가 직접 발행합니다.',
    ],
    tips: {
      h3: '홍콩 달러를 다룰 때',
      items: [
        '홍콩 달러는 1983년부터 미국 달러에 연동되어 있어 달러 대비로는 거의 움직이지 않습니다.',
        '원화 대비 변동은 대부분 달러 원화 쪽에서 옵니다.',
        '연동 환율이 같아도 환전소마다 마진이 달라 최종 금액은 달라집니다.',
        '지폐는 세 곳의 발권 은행이 각자 도안으로 발행하고, 10홍콩달러권만 정부가 발행합니다. 모두 같은 통화입니다.',
        '교통과 편의점 결제는 선불 교통카드로 처리되므로 현금 인출액을 줄일 수 있습니다.',
      ],
    },
    faq: [
      {
        q: '홍콩 달러 환율은 왜 거의 변하지 않나요?',
        a: '홍콩금융관리국이 연계환율제도로 미국 달러 대비 좁은 범위 안에서 관리하기 때문입니다. 1983년에 시작된 제도이고, 지금의 상하한은 2005년에 정해졌습니다. 값이 밴드 경계에 닿으면 당국이 시장에 개입합니다. 따라서 달러 대비로는 거의 평평하고, 원화 대비 움직임은 달러 원화 쪽에서 들어옵니다.',
      },
      {
        q: '홍콩 지폐는 도안이 여러 가지인데 같은 돈인가요?',
        a: '같습니다. 홍콩에서는 세 곳의 시중은행이 지폐를 발행하기 때문에 같은 액면에 서로 다른 도안이 존재합니다. 10홍콩달러권은 정부가 발행합니다. 가치도 환율도 동일하고, 환전할 때 구분되지 않습니다.',
      },
    ],
  },

  'sgd-krw': {
    lead:
      '싱가포르 달러(SGD)를 대한민국 원(KRW)으로 환산하면 싱가포르의 높은 물가가 원화 기준으로 정리됩니다. 싱가포르는 금리가 아니라 환율을 정책 수단으로 쓰는 드문 나라입니다. '
      + '높은 단가를 원화로 가늠하는 일은 {{app}}에 맡기면 되고, 저장된 환율 덕분에 기내에서도 그대로 됩니다.',
    h2: '환율로 통화정책을 하는 나라의 돈',
    body: [
      '싱가포르 통화청은 기준금리를 올리고 내리는 대신, 교역 상대국 통화 바스켓에 대한 싱가포르 달러의 실효환율을 정해진 기울기와 폭 안에서 관리합니다. 무역이 경제 규모에 비해 워낙 커서 환율이 물가에 더 직접적으로 작용하기 때문입니다. 그래서 정책 발표에서 금리 숫자를 찾는 습관은 여기서 통하지 않습니다.',
      '국내에서 이 통화가 필요해지는 이유는 대체로 셋입니다. 아시아 지역 본부가 몰려 있어 출장이 잦고, 창이 공항을 경유하며 시내에 하루 이틀 머무는 일정이 흔하며, 학비와 생활비를 옮기는 유학생과 주재원 가정이 있습니다. 체류가 짧아도 숙박과 외식 단가가 높은 편이라 금액을 그때그때 환산해 보는 습관이 필요합니다.',
      '표기에서 주의할 점이 하나 있습니다. 싱가포르 달러는 S$로 적지만 가격표에는 달러 기호만 찍히는 경우가 많아, 같은 기호를 쓰는 다른 나라 달러와 섞이기 쉽습니다. 또 싱가포르 달러와 브루나이 달러는 1967년 협정에 따라 두 나라에서 같은 가치로 통용되므로, 거스름돈으로 브루나이 지폐를 받아도 싱가포르에서 그대로 쓸 수 있습니다.',
    ],
    tips: {
      h3: '싱가포르 달러 메모',
      items: [
        '가격표의 달러 기호는 싱가포르 달러입니다. 다른 나라 달러와 혼동하지 마세요.',
        '싱가포르 통화청은 금리가 아니라 실효환율 밴드로 통화정책을 운용합니다.',
        '싱가포르 달러와 브루나이 달러는 1967년 협정에 따라 같은 가치로 통용됩니다.',
        '레스토랑 메뉴의 ++ 표기는 서비스 요금과 소비세가 따로 붙는다는 뜻입니다.',
        '{{app}}에 SGD를 즐겨찾기로 넣어 두면 출장 경비 정산이 빨라집니다.',
      ],
    },
    faq: [
      {
        q: '싱가포르 달러와 브루나이 달러는 서로 바꿔 쓸 수 있나요?',
        a: '1967년 통화 교환 협정에 따라 두 통화는 같은 가치로 인정되고, 양국에서 서로의 지폐를 받아 줍니다. 다만 상점에 따라 취급을 꺼리는 경우가 있으므로, 남은 브루나이 지폐는 은행 창구에서 바꾸는 편이 확실합니다.',
      },
      {
        q: '싱가포르는 왜 금리 대신 환율로 통화정책을 하나요?',
        a: '교역 규모가 국내 경제에 비해 매우 커서 수입 물가를 통해 환율이 물가에 직접 영향을 주기 때문입니다. 싱가포르 통화청은 교역 가중 실효환율의 중심선과 기울기, 변동 폭을 조정하는 방식으로 정책을 운용하고 이를 정기적으로 발표합니다.',
      },
    ],
  },
},

  zh: {
  'usd-cny': {
    lead:
      '美元兑人民币的实际换算交给 {{app}} 完成 —— 免费的 Android 与 iOS 应用，没有网络时改用最后一次保存下来的汇率。'
      + '本页讲的是这条线本身：在岸 CNY 和离岸 CNH 为什么报价对不上，钱从美国进内地又要过哪几道手续。',
    h2: '手里拿着美元、心里算着人民币的那些人',
    body: [
      '美元兑人民币是全世界查得最勤的一条汇率，在海外的华人尤其绕不开：在美国上班、每月给内地父母打钱的上班族，收美元报酬的自由职业者和跨境卖家，替家里付保费和房贷的人，还有单纯想知道抽屉里那几张美元现钞值多少人民币的人。他们盯的其实不是同一个数字——按月汇款的人关心这个月能到账多少，签合同的人关心三个月后收到货款还剩多少利润。',
      '人民币这一端有一套别的货币没有的机制。每个交易日北京时间上午九点一刻，中国外汇交易中心公布当天人民币对美元的中间价，内地的即期交易被限制在中间价上下百分之二的幅度内。所以内地的在岸人民币写作 CNY，是有管理的浮动；在香港等地成交的离岸人民币写作 CNH，由境外供求决定，放得开一些。两个报价通常贴得很近，却很少完全一致，不同网站给出的数字对不上，多半就是各自引用了其中一个。',
      '真正吃掉钱的地方在汇款路径上，不在行情。跨境电汇要经过中转行，路上被扣一笔手续费，收款人到账金额因此比汇出金额少，这跟汇率高低无关，汇出前先跟银行讲清楚这笔费用由谁承担。钱到了内地还有第二步：收款人得把外汇结汇成人民币，内地居民个人每年有等值五万美元的便利化结汇额度，超出部分要凭真实用途的材料单独办理。内地银行的牌价还把现钞和现汇分成两栏，账户里收到的汇款按现汇价，手里的美元纸币按现钞价，后者永远更难看——纸币要清点、保管、装箱运回去，这些成本都折进了价差。',
    ],
    tips: {
      h3: '把美元汇回内地之前值得确认的几件事',
      items: [
        '电汇的中转行费用先和银行说定由谁承担，否则收款人到账时会莫名其妙少一块。',
        '内地收款人每年有等值五万美元的便利化结汇额度，超过部分要凭真实用途的材料单独办理。',
        '内地银行的现钞买入价和现汇买入价是两个数，汇款按现汇、纸币按现钞，看错一栏就白亏一截。',
        '带着境外发行的卡回内地刷，收银机问按人民币还是按美元结算时选人民币，商户端的换汇价通常更差。',
        '把 USD/CNY 收藏进 {{app}}，打开就在第一行，不用每次重新搜一遍。',
      ],
    },
    faq: [
      {
        q: '人民币中间价和银行柜台给的价格为什么对不上？',
        a: '中间价是当天银行间市场的定价基准，不是零售报价。银行会在这个基准之上加自己的点差，并且把现钞和现汇分开计价，所以柜台上的数字必然偏离中间价。',
      },
      {
        q: 'CNY 和 CNH 到底差在哪里？',
        a: 'CNY 指内地的在岸人民币，受每日中间价和波动幅度的约束；CNH 指在香港等离岸市场成交的人民币，价格由境外供求决定。两者长期贴合，但同一时点几乎不会是同一个数。',
      },
    ],
  },

  'jpy-cny': {
    lead:
      '日元没有在流通的辅币，ISO 4217 指数是零，所以日本的价签是一串不带小数的整数，四位五位都很正常。'
      + '把这串数字折成人民币由 {{app}} 负责，地下商场没信号也照算；这一页说的是这条线上最容易看错的几处。',
    h2: '挣日元、算人民币的日常',
    body: [
      '在日本读书和工作的人是这条汇率最稳定的用户：领到手的是日元月薪，脑子里换算的却是人民币——这个月往家里汇多少合适，房租和学费折过来是什么水平，年底回去之前要不要多换一点。另一拨是短期来的旅客和做代购的人，他们得在几秒钟内判断眼前这个价签值不值。',
      '大阪心斋桥的药妆店、东京秋叶原的相机行、京都的老铺子，价签都是四位数起跳的整数，这是日元没有零钱位的自然结果，不是标错了。看惯人民币位数的人第一眼容易把几百块的东西看成几千块，或者反过来。把整串数字原样敲进 {{app}}，比在脑子里挪小数点靠谱得多。',
      '报价习惯也要留心一个差别：内地的银行在外汇牌价上不按一日元报价，日元和韩元这类面值小的货币通常以一百单位挂牌。家里人在银行牌价上看到的数字，和境外网站按单个日元给出的报价，中间隔着一百倍。两边核对之前，先确认单位是一元还是一百元。',
      '价签本身还有两层。日本商品常同时印出税抜价和税込价，一般商品的消费税是百分之十，餐饮和外带食品适用百分之八的轻减税率。免税只对短期访客开放，一般商品在同一天同一家店满五千日元起可以办；持在留资格长住的人没有这项资格，所以同一家店里，游客和留学生最终付的钱并不一样。',
    ],
    tips: {
      h3: '在日本花钱的几个细节',
      items: [
        '日元没有在流通的辅币单位，换算结果保留整数就够了，小数位在这里没有意义。',
        '内地银行牌价上的日元多半是每一百日元的价格，和境外按单个日元的报价差一百倍。',
        '价签上的税抜和税込是两个价，短期访客办完免税手续还会再低一截，长住的人用不上。',
        '不少小店、神社和乡下的餐馆只收现金，便利店的 ATM 对境外卡最稳，取钱前先估好金额。',
        '出门前在 {{app}} 里刷新一次汇率，地下铁和商场里没信号也能继续折算。',
      ],
    },
    faq: [
      {
        q: '为什么内地银行牌价上日元的数字和别处差一百倍？',
        a: '因为内地银行对日元这类小面值货币习惯以一百单位挂牌，牌价栏里写的是一百日元对人民币的价格，而多数国际报价是按单个日元给出的，所以看起来相差一百倍。',
      },
      {
        q: '日元价格为什么不带小数？',
        a: '日元的 ISO 4217 辅币指数是零，没有在流通的更小单位，因此价签只有整数。四位五位的数字在日本是日常价格，不是写错了位数。',
      },
    ],
  },

  'hkd-cny': {
    lead:
      '港元盯的是美元，不是人民币：香港自一九八三年起实行联系汇率制度，二〇〇五年起金管局的双向兑换保证把它约束在七点七五到七点八五之间。'
      + '所以港元兑人民币的波动，几乎全部来自美元兑人民币那一段。此刻具体折多少，{{app}} 一按就有；这里要讲的是这条线为什么长成这样。',
    h2: '为什么港元兑人民币的走势像是美元的影子',
    body: [
      '香港实行的是联系汇率制度：一九八三年起港元按七点八零兑一美元与美元挂钩，二〇〇五年起金管局给出双向兑换保证——强方保证在七点七五，弱方保证在七点八五，港元就在这条窄带里活动。结果是港元几乎没有自己的行情：港元折人民币的数字在动的时候，动的原因通常不在香港，而在美元对人民币那一头。想判断这条线接下来往哪走，看美元的走向比看本地新闻有用。',
      '正因为基准这么稳，成本就全落在基准之上那层加价里。银行柜台、市区的找换店、口岸和机场的兑换窗口，引用的是同一个几乎不动的基准，报出来的数字却相差不小。同样一笔钱，在旺角的老字号找换店和在机场离境层换，拿到手的人民币可以差出一顿饭钱——差别来自点差，不是行情。',
      '这条线上最活跃的是北上消费的人：周末过关去深圳吃饭、剪头发、买菜，或者在内地的电商下单寄回来。香港店铺的标价不含任何销售税，看到多少付多少；内地的标价同样是含税价，所以两边的数字折算之后可以直接比。要留意的是付款方式：内地不少小店只认扫码，香港发行的卡未必刷得了，过关前把支付工具绑好，比到了柜台再翻现金省事。',
    ],
    tips: {
      h3: '过关前后的几个提醒',
      items: [
        '港元与美元挂钩，兑换保证的两端是七点七五和七点八五，人民币那一边才是这条线的变量。',
        '一港元等于一百仙，日常见到的硬币是一毫、二毫、五毫，也就是十仙、二十仙和五十仙。',
        '香港的纸币由汇丰、渣打和中银香港三家发钞银行印发，十元面额由政府发行，图案不同但都是同一种钱。',
        '香港标价不含销售税，看到多少付多少，折成人民币后可以直接和内地的价格比。',
        '基准几乎不动的时候，唯一还能省的就是点差，多问两家找换店再决定。',
      ],
    },
    faq: [
      {
        q: '港元既然和美元挂钩，为什么兑人民币的数字还是天天在变？',
        a: '因为变的那一端不是港元。港元对美元被约束在七点七五到七点八五之间，港元折人民币的数字随着美元对人民币的行情一起移动，本质上是人民币那条线在动。',
      },
      {
        q: '在香港换人民币和过关之后再换，哪边划算？',
        a: '两边引用的基准几乎相同，差别只在各家加了多少点差、收不收手续费。机场和口岸的柜台通常最贵，市区门店和银行往往好一些，值得多比一两家。',
      },
    ],
  },

  'krw-cny': {
    lead:
      '韩元和日元一样没有辅币位，ISO 4217 指数为零，所以一杯咖啡就是四位数、一件外套五六位数的整数。'
      + '把价签上那串数字折成人民币，交给 {{app}} 就好，断网时它用最后保存的汇率；下文讲的是首尔最容易算糊涂的几个场合。',
    h2: '在首尔读书、上班和买韩国货的人怎么算这笔账',
    body: [
      '好在中文和韩文都按万分节，韩国人写的五万和中文说的五万是同一个习惯，读韩元价格因此比读越南盾轻松得多。真正的坑不在分节而在位数：明洞化妆品店里几万块的价签和百货公司里几十万的价签只差一位，扫一眼很容易看漏，而少看一位就是十倍。',
      '长住的人——语言学校和大学的学生、在本地企业上班的技术人员——盯这条线的理由是钱要来回走：学费按学期缴，租房的押金一次性交出去数目不小，而每月往家里汇的那笔钱，到账后是多少人民币取决于汇出那天的行情。',
      '免税店是另一个容易算糊涂的地方。仁川机场和市内免税店有不少商品直接用美元标价，结账时再按店内当天的换算价扣成韩元，于是同一件东西出现了三种币值。碰到这种情况，把美元价和韩元价各自折成人民币比一比，往往会发现两条路径差得不少。韩国商品价格含百分之十的增值税，短期访客符合条件可以退税，很多商店支持结账时即时退还，长期居留的人则没有这项资格。',
    ],
    tips: {
      h3: '在韩国和买韩国货的实用提示',
      items: [
        '韩元没有在流通的辅币，换算结果取整就行，看价签时先数清楚有几位。',
        '内地银行牌价上的韩元通常按一百韩元挂牌，和家里人核对数字前先确认单位。',
        '韩国商品价格含百分之十的增值税，短期访客可以退税，不少店支持结账时即时退还。',
        '在韩国网站结账时选韩元扣款，让发卡行去换，商户自己给的人民币价通常更贵。',
        'T-money 交通卡用现金充值，身上留一点韩元零钞比全靠刷卡省事。',
      ],
    },
    faq: [
      {
        q: '免税店用美元标价，我该按哪个价换算？',
        a: '把美元标价和韩元标价分别折成人民币再比较。免税店自己使用的内部换算价往往不等于市场参考汇率，两条路径算下来的人民币金额可能相差不小。',
      },
      {
        q: '韩元价格位数太多，有什么不容易看错的办法？',
        a: '按韩文和中文共通的万位分节去读，先确认是几万还是几十万，再把整串数字原样交给 {{app}} 折算，不要在脑子里挪位。少看一位就是十倍的误差。',
      },
    ],
  },

  'eur-cny': {
    lead:
      '欧元区各国共用同一种货币，所以从巴黎一路到米兰，要盯的只有欧元兑人民币这一条线。'
      + '折多少由 {{app}} 算，火车上关掉漫游也不影响；这一页讲的是刷卡、退税和读数上那几个坑。',
    h2: '在欧洲挣欧元的人，怎么把它折回人民币',
    body: [
      '欧元最省心的地方是覆盖面：跨过法国到意大利、再到西班牙，钱包里的钞票不用换，心里的换算公式也只有一条。最容易出错的反而是数字的写法。德国、法国、意大利多数场合用点号做千位分隔、用逗号做小数点，和中文的习惯正好反过来，一件标着一千二百多欧元的包，很容易被读成一点二欧元。看价签先找那个逗号在哪。',
      '第二个坑发生在刷卡的一瞬间。欧洲的收银机和 ATM 经常弹出一句「按人民币结算还是按欧元结算」，看上去贴心，实际是商户端的动态货币转换，换算价由收单方定，通常比发卡机构的价格差。选欧元，把折成人民币这一步留在自己这一侧。ATM 问要不要锁定汇率时同理，拒绝就好。',
      '第三件事和身份有关。欧盟境内的标价已经含增值税，看到多少付多少；而离境退税只对不在欧盟长期居留的人开放，持居留许可在这里读书或工作的人买东西退不了税，真能办的是从内地来探亲旅行的家人。流程也有讲究：在店里开好退税单，离境前在最后一个欧盟国家的海关办确认，再选退现金还是退回卡里。退现金要扣手续费，退回卡里到账慢但通常划算，而退回来的欧元最终折成多少人民币，取决于到账那天的汇率，不是购物那天。',
    ],
    tips: {
      h3: '在欧元区花钱的几个细节',
      items: [
        '欧洲多数国家用点号分千位、逗号做小数点，读价签时先定位小数点再换算。',
        '收银机问按人民币还是按欧元结算时选欧元，这一步能省下商户端的换汇加价。',
        '标价已经含增值税，换算出来就是实付金额，不必再补一道税。',
        '离境退税只对非欧盟居民开放，退税单要在最后一个欧盟国家的海关办确认。',
        '欧洲央行的货币政策会议有公开日程，重要日子前后这条线容易走得急一些。',
      ],
    },
    faq: [
      {
        q: '在欧洲刷卡时选人民币结算是不是更方便？',
        a: '方便，但通常更贵。那是商户端的动态货币转换，换算价由对方设定。选欧元结算，折成人民币这一步交给发卡机构处理，一般更接近市场参考汇率。',
      },
      {
        q: '退税退回来的钱怎么折算成人民币？',
        a: '退税金额以欧元计算，最终折成多少人民币取决于退款到账那一天的汇率，而不是购物当天。退现金还要扣一笔手续费，退回信用卡通常到手更多。',
      },
    ],
  },

  'twd-cny': {
    lead:
      '台湾也把货币单位叫作元，所以台北价签上的一百元指的是新台币，不是人民币，两者数量级完全不同。'
      + '价签数字用 {{app}} 折一遍就不会看错，夜市里没信号也能算；这一页讲的是新台币在兑换和支付上的特别之处。',
    h2: '两岸之间来回算账，先弄清楚这个「元」',
    body: [
      '同一个字带来的误会在这条线上格外多。台北捷运站旁的便当店写着一百元，士林夜市的鸡排写着几十元，按人民币去理解就会觉得贵得离谱或者便宜得离谱。新台币的书面写法是 NT$ 或者 TWD，口语里就是元和块，跟人民币完全同名。看到价格先确认自己站在哪一边的柜台前，再动手换算。',
      '兑换渠道也和别的货币不一样。新台币在国际外汇市场上不是自由买卖的货币，境外报价多半要通过美元交叉折算，内地的银行网点也很少常备新台币现钞。所以钱要过这条线，多数人不换现钞：走银行汇款，或者到了当地用卡在 ATM 取现。带着现钞出入境还有申报门槛，超过规定金额要主动申报，别抱着侥幸。',
      '花钱的方式偏传统。夜市、路边摊、小吃店以现金为主；悠游卡和一卡通覆盖捷运、公交和便利店；刷卡在百货和连锁店没问题，在小店未必。台湾的营业税已经含在标价里，看到多少付多少，所以换算出来的人民币数字可以直接拿去和内地的同类商品比较，不用再补一道税。',
    ],
    tips: {
      h3: '新台币的使用提示',
      items: [
        '价签上的元一律是新台币，和人民币同名不同值，看到数字先在心里贴上 TWD 的标签。',
        '日常流通的最小面额是一元，找零不会出现小数，角早就退出了日常使用。',
        '内地的银行网点很少常备新台币现钞，出发前先问清楚，或者到当地银行和机场再换。',
        '悠游卡和一卡通能覆盖交通与便利店，夜市和小吃摊则要准备现钞。',
        '标价已含营业税，换算出的人民币金额就是实际要付的钱。',
      ],
    },
    faq: [
      {
        q: '台湾价签上写的元是人民币还是新台币？',
        a: '是新台币。台湾口语和书面都把货币单位叫元或块，写法上有时会加 NT$ 或 TWD 区分。看到价格请按新台币折算，两者的数量级差得很远。',
      },
      {
        q: '为什么新台币现钞在台湾以外不好换？',
        a: '新台币在国际市场上不是自由买卖的货币，境外流通量有限，包括内地在内的多数银行网点不常备现钞。常见做法是到当地银行、机场柜台兑换，或者直接用卡在当地取现。',
      },
    ],
  },

  'thb-cny': {
    lead:
      '泰铢的辅币叫萨当，一泰铢等于一百萨当，但日常几乎只用整铢，所以折成人民币时小数位没什么用。'
      + '换算这一步归 {{app}} 管，海岛上没信号也能接着折；这一页讲的是泰国这条线上最贵的几步。',
    h2: '常住曼谷清迈的人，和只待一周的人，账不一样',
    body: [
      '这条线上最贵的一步几乎总是取现。泰国的 ATM 对境外银行卡另收一笔固定费用，多数银行是每笔两百二十泰铢，跟取多少钱无关。取一千泰铢和取两万泰铢，这笔钱一样多，所以频繁小额取现是纯亏。真要用现金，把次数压到最少、每次多取一些，比纠结哪家银行的汇率有用得多。',
      '换钞的门道也很清楚。素万那普机场到达层的柜台通常最不划算，市区里那些专做兑换生意的门店报价明显好，常见的做法是在机场只换够路费，进了市区再换剩下的。ATM 和收银机会问要不要按人民币扣款，那是商户端的换汇，选泰铢，让自己的发卡机构去完成这一步。',
      '好消息是很多场合已经不必换钞。曼谷的商场、便利店、连锁餐厅乃至不少街边摊都贴着二维码，扫码可以直接付泰铢，扣款按发卡机构的汇率折算。还需要现金的主要是出租车、夜市、海岛上的小店和寺庙门票。泰国商品含百分之七的增值税，短期访客在指定商店消费达到门槛可以在离境时办退税，退回来的钱按到账日折算；拿长期签证住在这里的人用不上这一条，日常成本要按含税价来算。',
    ],
    tips: {
      h3: '在泰国少花冤枉钱的几条',
      items: [
        '境外卡在泰国 ATM 取现，多数银行每笔另收两百二十泰铢的固定费，尽量少取几次、每次多取。',
        '机场到达层的兑换柜台一般最贵，市区专营兑换的门店报价通常好不少。',
        'ATM 或收银机问是否按人民币扣款时选泰铢，商户端的换汇价普遍更差。',
        '商场和便利店大多支持扫码付款，现金主要留给出租车、夜市和海岛小店。',
        '出门前在 {{app}} 里更新一次汇率，离岛和山区信号差的时候还能照常换算。',
      ],
    },
    faq: [
      {
        q: '在泰国用 ATM 取现为什么这么贵？',
        a: '泰国的取款机对境外卡收取一笔固定费用，多数银行是每笔两百二十泰铢，与取款金额无关，再加上发卡机构自己的手续费。取的次数越多越吃亏，一次取足是最省的做法。',
      },
      {
        q: '在泰国扫码付款和换现钞哪个划算？',
        a: '扫码付款按发卡机构的汇率折算，通常比机场柜台的现钞价更接近市场参考汇率。现金主要留给不支持扫码的出租车、夜市和小店，换少量应急即可。',
      },
    ],
  },

  'gbp-cny': {
    lead:
      '英镑分一百便士，单位价值在主要货币里偏高，所以英国价签上的数字看着小，折成人民币之后往往不小。'
      + '要算清楚就用 {{app}}，免费，没网也照样出结果；这一页讲的是学费、退税和报价方向上的门道。',
    h2: '在英国读书和生活，这条线上的钱怎么算',
    body: [
      '这条汇率的主力用户是留学生和刚工作的年轻人。英国学费按学年报价、分期缴纳，加上押金和住宿费，一次要动的金额不小；生活费那一端则是反过来的，家里汇来的钱折成英镑够花几个月，决定了下学期的松紧。签证阶段还有一条很硬的规定：用来证明生活费的钱必须在账户里连续存满二十八天，临时凑数不算，所以时间要提前留出来。',
      '购物这一侧有一个很多人还不知道的变化：面向访客的商店零售出口退税已经取消，在英国本土买东西不再像在欧盟那样能在离境时退掉增值税。英国的标价含百分之二十的标准增值税，看到多少付多少，换算出来的人民币就是实付金额，不要再按退税后的价格做预算。',
      '还有一个读数习惯要注意。外汇市场按惯例把英镑放在前面报价，新闻里出现的那个数字通常是一英镑值多少美元，而不是反过来。照着新闻的方向去理解英镑兑人民币，很容易把关系读反。另外，苏格兰和北爱尔兰的银行发行自己的英镑纸币，面值与汇率和英格兰银行的钞票完全相同，只是英格兰部分商户对这些版本不太熟悉。',
    ],
    tips: {
      h3: '英镑相关的几个提醒',
      items: [
        '英国标价含百分之二十的标准增值税，访客退税已经取消，按标价做预算即可。',
        '签证所需的生活费存款要在账户里连续存满二十八天，最好提早规划。',
        '苏格兰和北爱尔兰的银行发行自己的英镑纸币，面值与汇率完全相同，只是图案不同。',
        '看到新闻里的英镑报价先确认方向，市场惯例是把英镑放在前面。',
        '把 GBP/CNY 放进 {{app}} 的收藏，缴费日前后随手看一眼就够。',
      ],
    },
    faq: [
      {
        q: '在英国买东西还能退增值税吗？',
        a: '在英国本土已经不能了，面向访客的商店零售出口退税计划已经取消。标价里含的百分之二十增值税就是最终成本，做预算时按标价折算人民币即可。',
      },
      {
        q: '苏格兰的纸币和英格兰的一样值钱吗？',
        a: '一样。它们是同一种货币、同一个汇率，只是由不同银行发行、图案不同。换算时不需要做任何区分，只是在英格兰部分商户可能对这些版本比较陌生。',
      },
    ],
  },

  'aud-cny': {
    lead:
      '澳元的行情和中国的需求高度绑定：铁矿石和煤炭是澳大利亚的主要出口，中国是最大买家。'
      + '所以这条线走强走弱，原因常常在海的另一边。数字本身让 {{app}} 去算，这一页讲的是这种联动，以及在澳大利亚花钱要留意的规矩。',
    h2: '读书、定居和资源行情共同决定的一条线',
    body: [
      '澳元被称为商品货币不是修辞。铁矿石和煤炭在澳大利亚出口中占了很大比重，中国又是最主要的买家，于是澳元对人民币的走势常常跟着中国钢铁和基建的需求走，而不只是跟着澳大利亚储备银行的会议纪要。对在这里读书、上班、每年往家里汇一两笔钱的人来说，这意味着一个有点反直觉的结论：判断什么时候换汇，看中国的产业行情可能和看本地新闻一样有参考价值。',
      '花钱这一侧的规则相对友好。澳大利亚的标价已经含了百分之十的商品服务税，看到多少付多少；餐厅不需要额外给小费，账单上的数字就是全部。一分和两分硬币在一九九二年退出流通，现金结账时总额按最接近的五分取整，刷卡则照常精确到分，所以同一笔消费付现金和刷卡，尾数偶尔会差几分钱。',
      '离境时还有一笔可以拿回来的钱。旅客退税方案允许在离境前六十天内、在同一家商户消费满三百澳元的旅客，在机场的退税柜台申请退还商品服务税，商品要随身带着接受查验——回去探亲前买的礼物往往正好符合条件。退回来的金额以澳元计，折成多少人民币取决于到账那天，通常已经是落地之后的事了。',
    ],
    tips: {
      h3: '和澳元打交道的几件事',
      items: [
        '澳大利亚一九八八年发行了世界上第一张聚合物钞票，到一九九六年整套面额都换成了聚合物，泡了水也不至于报废。',
        '标价含百分之十的商品服务税，餐厅不用给小费，账单金额就是实付金额。',
        '一分两分硬币已停用，现金结账按五分取整，刷卡仍精确到分。',
        '同一商户消费满三百澳元并在六十天内离境的旅客，可以在机场申请退还商品服务税。',
        '资源类新闻对这条线的影响不小，用 {{app}} 拉一张五年走势图更容易看出当前位置。',
      ],
    },
    faq: [
      {
        q: '为什么澳元兑人民币会跟着中国的钢铁行情动？',
        a: '因为铁矿石和煤炭是澳大利亚的支柱出口，而中国是最大的买家。对这些原材料的需求变化会直接影响外界对澳元的需求，这种联动是长期倾向，不是每天都灵的规律。',
      },
      {
        q: '在澳大利亚现金付款为什么金额会被抹掉几分？',
        a: '因为一分和两分硬币已经退出流通，现金交易的总额按最接近的五分取整。刷卡和转账不受影响，仍然精确到分，所以两种付款方式的最终金额可能略有出入。',
      },
    ],
  },

  'sgd-cny': {
    lead:
      '新加坡金管局用汇率而不是利率作为主要的货币政策工具，让新元对一篮子货币在设定的区间内运行。'
      + '这让新元的走势比多数货币平稳。换成人民币是多少，打开 {{app}} 就有；这一页讲的是这套机制，以及新元几个少有人提的安排。',
    h2: '在新加坡上班和读书的人为什么盯着新元',
    body: [
      '新加坡的做法在全球是少数派。别国的央行调利率，新加坡金融管理局调的是新元名义有效汇率的运行区间——斜率、宽度和中心水平。对一个以贸易立国、日用品几乎全靠进口的城市国家来说，管住汇率就等于管住了输入型通胀。落到普通人身上，结果是新元对人民币的曲线通常比澳元、英镑那几条平缓，剧烈的单日跳动不多见，按月往家里汇一笔钱的人不太需要为择时纠结。',
      '还有一个几乎没人提但很实用的安排：新元和文莱元自一九六七年起等值互换，文莱元在新加坡可以按面值使用，反之亦然。在这里收到一张文莱元纸币不用慌，它不是假钞，也不需要打折。',
      '常查这条汇率的人集中在几类：在本地上班、每月往家里汇钱的白领，把孩子送来读中小学和大学的家庭，以及把新加坡当结算中心、在东南亚跑业务的人。新加坡的标价含商品服务税，税率为百分之九，短期访客在参与退税计划的商店单店消费达到门槛可以在离境时申请退还，长期居留的人没有这项资格。日常支付方面，扫码和刷卡覆盖极广，现金反而用得越来越少。',
    ],
    tips: {
      h3: '新元的几个实用知识',
      items: [
        '新元与文莱元等值互换，两国的纸币在对方境内都能按面值使用。',
        '新加坡金管局通过管理汇率区间来执行货币政策，所以新元的日内波动通常比较克制。',
        '标价含百分之九的商品服务税，符合条件的短期访客可以在离境前申请退还。',
        '扫码和刷卡在新加坡覆盖极广，随身带少量现钞应急就够。',
        '常汇钱的人可以把 SGD/CNY 固定在 {{app}} 的收藏列表顶部，省去每次搜索。',
      ],
    },
    faq: [
      {
        q: '为什么新加坡的中央银行调汇率而不是调利率？',
        a: '新加坡是高度依赖进出口的小型开放经济体，物价对汇率比对利率敏感得多。金管局因此把新元名义有效汇率的运行区间当作主要政策工具，通过调整区间来影响物价。',
      },
      {
        q: '在新加坡拿到文莱元的钞票怎么办？',
        a: '直接用就行。两国自一九六七年起实行货币等值互换，文莱元在新加坡按面值流通，不需要打折，也不需要专门去银行兑换。',
      },
    ],
  },

  'cad-cny': {
    lead:
      '加元和美元共用一个美元符号，所以看到写着这个符号的加拿大价签，先确认它是加元还是美元，两者并不等值。'
      + '确认之后再用 {{app}} 折成人民币，免费、离线可用；这一页讲的是到了加拿大要改掉的几个算账习惯。',
    h2: '在加拿大生活要改掉的几个算账习惯',
    body: [
      '第一个要改的习惯是：加拿大的价签不含税。多伦多超市货架上的数字、餐厅菜单上的数字，都是税前价，结账时再加上联邦商品服务税和各省自己的销售税，有些省份把两者合并成统一销售税，税率各省不同。所以把价签折成人民币只是第一步，真正付出去的钱要在这个基础上再往上加一截。餐厅还要另外给小费，通常按税前金额的百分之十五到二十。',
      '第二个是硬币。加拿大从二〇一三年起停止流通一分硬币，现金结账时总额按最接近的五分取整，刷卡和转账则仍然精确到分。所以同一顿饭付现金和刷卡，账单尾数可能不一样，这是制度设计而不是算错了。',
      '第三件事跟钱的进出有关。携带等值一万加元以上的现金或票据出入加拿大，必须向边境服务局申报，这跟这笔钱来路是否正当无关，只是一项申报义务，漏报可能被扣留。把钱汇回去或者从家里汇过来，走银行电汇要留意中转行费用，走持牌汇款机构则要看它给的汇率和手续费加起来是多少，只比其中一项没有意义。加元本身和原油价格有长期联系，能源行情剧烈波动的时候，这条线也会跟着走。',
    ],
    tips: {
      h3: '加元使用提示',
      items: [
        '加拿大标价一律不含税，结账时再加联邦税和省税，各省税率不同，预算要留出余量。',
        '一分硬币已停止流通，现金结账按五分取整，刷卡仍精确到分。',
        '餐厅小费通常按税前金额的百分之十五到二十计算，不含在账单里。',
        '携带等值一万加元以上的现金或票据出入境需要主动申报。',
        '魁北克的价签和账单常以法语标示，看不懂时先找那个货币符号和数字。',
      ],
    },
    faq: [
      {
        q: '加拿大的价签为什么和结账金额不一样？',
        a: '因为标价不含销售税。结账时会加上联邦商品服务税以及所在省份的销售税，部分省份合并为统一销售税。换算人民币时按最终账单金额来算才准确。',
      },
      {
        q: '加元和美元都用同一个符号，怎么分辨？',
        a: '看有没有前缀。加元常写作 CAD 或者在符号前加国别标识，美元则写作 USD。价签上没有标注时，按所在国家判断，并用 {{app}} 把数字折算一遍，不要默认两者等值。',
      },
    ],
  },

  'myr-cny': {
    lead:
      '林吉特不是一种可以在境外自由买卖的货币：马来西亚国家银行限制林吉特在离岸市场交易，所以马来西亚以外的银行很少备有这种现钞。'
      + '钱要过这条线，多半得走汇款或者扫码。预算先用 {{app}} 折一遍，这一页讲的是兑换、账单和支付上的实际情况。',
    h2: '林吉特和人民币之间，钱是怎么过去的',
    body: [
      '这条线最特别的地方在兑换环节。马来西亚国家银行长期限制林吉特在境外交易，林吉特因此不是一种可以在国际市场自由买卖的货币，马来西亚以外的银行网点备有林吉特现钞的很少，能换到的数量也有限。带着一沓林吉特出境去别处兑换，通常只能拿到很难看的价格；反过来，来马来西亚的人多半是在吉隆坡国际机场先换够路费，进了市区再到商场里的持牌兑换商换剩下的，市区门店的报价一般明显好过机场到达层。',
      '货币本身很好读。一林吉特分一百仙，书写上常用 RM 打头，价签上写 RM 十几二十就是普通一餐的价格。要留意的是账单的下半截：餐厅和酒店常在菜单价之外另加服务费，再叠加销售与服务税，最终付款金额会比菜单上的数字高出一截，直接把菜单价折成人民币容易低估。',
      '支付方式这几年变化很快。马来西亚的本地二维码支付已经和内地的移动支付打通，商场、连锁餐饮和不少小店都能直接扫码，扣款按发卡机构的汇率折算，省掉了换钞这一步。跨境汇款则有银行和持牌汇款机构两条路，后者手续费低但汇率未必好，两项加起来比较才算数。常住的人还会关心另一件事：马来西亚是棕榈油和液化天然气的出口国，大宗商品行情走强的时候，林吉特往往跟着动。',
    ],
    tips: {
      h3: '林吉特的实用提示',
      items: [
        '一林吉特等于一百仙，价签通常以 RM 开头，别和新加坡元的符号搞混。',
        '马来西亚以外的银行很少备有林吉特现钞，出境前不必囤，回来再换更划算。',
        '机场到达层的报价通常最差，市区商场里的持牌兑换商明显好一些。',
        '餐厅账单常在菜单价之外加服务费和税，按菜单价折算容易低估实际花费。',
        '本地二维码支付已和内地的移动支付打通，扫码消费可以省去换钞这一步。',
      ],
    },
    faq: [
      {
        q: '为什么林吉特在马来西亚以外很难换到？',
        a: '马来西亚国家银行限制林吉特在离岸市场交易，境外流通量因此很小，包括内地在内的多数银行网点不备这种现钞。常见做法是在马来西亚本地的机场或市区持牌兑换商兑换。',
      },
      {
        q: '在马来西亚的餐厅结账，为什么比菜单价高？',
        a: '因为账单上通常会另加服务费，并按规定叠加销售与服务税。做预算时把菜单价上浮一档再折成人民币，会比直接换算菜单数字更接近实际支出。',
      },
    ],
  },
},

  hi: {
  'usd-inr': {
    lead:
      'एक अमेरिकी डॉलर कई भारतीय रुपयों के बराबर होता है, इसलिए USD से INR में बदलने पर रकम का आँकड़ा कई गुना बड़ा दिखता है। '
      + 'यह गुणा-भाग {{app}} फ़ोन पर कर देता है, डेटा बंद हो तब भी, आख़िरी सहेजे गए भाव से।',
    h2: 'डॉलर से रुपया कौन बदलता है',
    body: [
      'भारत दुनिया में सबसे ज़्यादा विदेशी प्रेषण पाने वाला देश है, और उसमें सबसे बड़ा अकेला हिस्सा अमेरिका से आता है। इसी वजह से इस जोड़ी को ट्रेडिंग टर्मिनल से कहीं ज़्यादा घरों में देखा जाता है। तरीक़ा भी अलग है: लोग कई दिन तक भाव पर नज़र रखते हैं, फिर एक झटके में बड़ी रकम भेज देते हैं, क्योंकि बड़ी रकम पर थोड़ी सी हलचल भी असली पैसा बन जाती है। आया हुआ पैसा अक्सर एनआरई या एनआरओ खाते में उतरता है, और इन दोनों खातों के नियम एक जैसे नहीं हैं।',
      'दूसरा बड़ा तबका छात्रों का है। अमेरिकी यूनिवर्सिटी की फ़ीस डॉलर में जाती है, और भारत से पैसा उदारीकृत प्रेषण योजना यानी LRS के रास्ते जाता है, जिसमें एक निवासी व्यक्ति हर वित्त वर्ष में ढाई लाख डॉलर तक विदेश भेज सकता है। एक तय सीमा से ऊपर की रकम पर बैंक स्रोत पर कर संग्रह यानी TCS भी काटता है, जो बाद में आयकर रिटर्न में समायोजित होता है। यह कटौती लागत नहीं है, पर उस महीने की नक़दी ज़रूर घेर लेती है।',
      'तीसरा हिस्सा उल्टी दिशा का है: अमेरिकी क्लाइंट को डॉलर में बिल भेजने वाले फ्रीलांसर, छोटी सॉफ़्टवेयर कंपनियाँ और सलाहकार। यहाँ रुपया उस दिन बनता है जिस दिन पैसा खाते में जमा होता है, बिल की तारीख़ पर नहीं। बीच में बैंक का इनवर्ड रेमिटेंस चार्ज और विदेशी मुद्रा सेवा पर GST भी बैठता है, इसलिए बैंक की सलाह में दिखी रकम और यहाँ का संदर्भ भाव कभी बराबर नहीं होंगे। अंतर कितना है, यही एकमात्र सवाल पूछने लायक़ है।',
    ],
    tips: {
      h3: 'डॉलर-रुपया: गाँठ बाँध लेने वाली बातें',
      items: [
        'भारत में अंक 2-2-3 के समूह में लिखे जाते हैं, यानी एक लाख को 1,00,000 की तरह — विदेशी साइट से चिपकाया गया आँकड़ा इसी वजह से अजीब लगता है।',
        'रुपये का ISO 4217 घातांक 2 है, पर सिक्कों में पैसे अब चलन से बाहर हैं; डिजिटल भुगतान में दशमलव अब भी काम करता है।',
        'तय शुल्क पूरी रकम पर फैलता है, इसलिए एक बड़ा ट्रांसफ़र अक्सर कई छोटे ट्रांसफ़रों से सस्ता पड़ता है।',
        'बैंक की सलाह पर लिखा "कार्ड रेट" उसका अपना भाव है; यहाँ के संदर्भ भाव से उसका अंतर ही ट्रांसफ़र की असली क़ीमत है।',
        'इस जोड़ी को {{app}} में पसंदीदा बना लें, तो ऐप खुलते ही सबसे ऊपर दिखेगी।',
      ],
    },
    faq: [
      {
        q: 'लाख और करोड़ को डॉलर में कैसे समझें?',
        a: 'एक लाख यानी सौ हज़ार रुपये और एक करोड़ यानी सौ लाख रुपये। ये अलग इकाइयाँ नहीं, अंक लिखने का तरीक़ा हैं, इसलिए पूरा आँकड़ा जस का तस {{app}} में डालकर डॉलर में बराबरी देख लीजिए।',
      },
      {
        q: 'बैंक ने जो USD/INR भाव लगाया, वह {{app}} के भाव से अलग क्यों है?',
        a: 'बैंक अपना कार्ड रेट लगाता है, जिसमें उसका मार्जिन पहले से मिला होता है, और उसके ऊपर सेवा शुल्क तथा विदेशी मुद्रा सेवा पर GST जुड़ता है। {{app}} अंतर-बैंक संदर्भ भाव दिखाता है, यानी वह आधार जिस पर बाक़ी सब जोड़ा जाता है।',
      },
    ],
  },

  'aed-inr': {
    lead:
      'यूएई दिरहम 1997 से अमेरिकी डॉलर पर एक तय दर पर बँधा है, इसलिए AED से INR का भाव तभी हिलता है जब रुपया डॉलर के मुक़ाबले हिलता है। '
      + 'दिरहम को रुपये में {{app}} बदलता है, और वह एक्सचेंज हाउस की क़तार में खड़े-खड़े, बिना नेटवर्क भी काम करता है।',
    h2: 'दिरहम से रुपया: खाड़ी का सबसे बड़ा रास्ता',
    body: [
      'खाड़ी से भारत आने वाले पैसे का सबसे बड़ा स्रोत संयुक्त अरब अमीरात है, और पूरी दुनिया में भी यह भारत के सबसे बड़े प्रेषण-स्रोतों में गिना जाता है। वहाँ बसा भारतीय समुदाय अमीरात की सबसे बड़ी प्रवासी आबादी है। इस रास्ते की अपनी लय भी है: तनख़्वाह महीने के आख़िरी दिनों में खाते में आती है, और अगले दो-तीन कामकाजी दिनों में काउंटर पर सबसे लंबी क़तार लगती है। जनवरी 2022 से अमीरात का सप्ताहांत शनिवार-रविवार हो गया, यानी वहाँ का दफ़्तरी हफ़्ता अब वैश्विक बाज़ार के हफ़्ते से मेल खाता है — भेजने वालों के लिए यह छोटी सी बात बहुत काम की है।',
      'दिरहम की तय दर इस पेज का सबसे उपयोगी तथ्य है। दिरहम डॉलर के सामने हिलता ही नहीं, इसलिए करामा या मीना बाज़ार के बोर्ड पर दिखने वाला उतार-चढ़ाव दरअसल दिरहम का नहीं, रुपये का होता है। इसका सीधा नतीजा यह है कि AED/INR का अंदाज़ा लगाना हो तो रुपये और डॉलर की ख़बरें पढ़िए; अमीरात की तरफ़ से इस भाव में कुछ नहीं जुड़ता, और "आज दिरहम मज़बूत है" जैसी बात यहाँ बेमानी है।',
      'बाक़ी सब मार्जिन है। लंगर तय है, इसलिए एक ही दोपहर को दो एक्सचेंज हाउस जो अलग-अलग भाव लिखते हैं, वह फ़र्क़ बाज़ार का नहीं, उनके अपने हिस्से का है। ऊपर से हर बार एक निश्चित शुल्क लगता है, जो रकम के साथ नहीं बढ़ता। ओणम, दीवाली और स्कूल फ़ीस के मौसम में जब भेजने वालों की भीड़ बढ़ती है, यही हिस्सा चुपचाप चौड़ा हो जाता है, और तब भाव देखकर नहीं, हाथ में आई रकम गिनकर तुलना करनी चाहिए।',
    ],
    tips: {
      h3: 'दिरहम भेजने से पहले',
      items: [
        'दिरहम का सौवाँ हिस्सा फ़िल्स कहलाता है; रोज़मर्रा में 25 और 50 फ़िल्स के सिक्के ही दिखते हैं।',
        'काउंटर पर लगे बोर्ड को यहाँ के संदर्भ भाव से मिलाकर देखें — दोनों का अंतर ही उस काउंटर की कमाई है।',
        'हर बार तय शुल्क लगता है, इसलिए एक ही महीने में रकम को टुकड़ों में भेजना शुल्क को कई गुना कर देता है।',
        'लंगर की वजह से यहाँ मज़बूत या कमज़ोर सिर्फ़ रुपया होता है; दिरहम की तरफ़ से कोई ख़बर नहीं आती।',
        'भाव {{app}} में सहेजकर हफ़्ते भर की तुलना कर लें, फिर काउंटर की तरफ़ निकलें।',
      ],
    },
    faq: [
      {
        q: 'दिरहम डॉलर से बँधा है तो AED/INR रोज़ क्यों बदलता है?',
        a: 'बँधी हुई सिर्फ़ एक टाँग है। दिरहम डॉलर के सामने तय है, पर रुपया डॉलर के सामने खुला तैरता है, इसलिए दोनों को जोड़ने वाला भाव रुपये की चाल के साथ रोज़ बदलता रहता है।',
      },
      {
        q: 'क्या महीने के आख़िर में भेजने पर घाटा होता है?',
        a: 'संदर्भ भाव तारीख़ नहीं देखता, पर काउंटर देखते हैं। भीड़ वाले दिनों और सप्ताहांत पर, जब अंतर-बैंक बाज़ार बंद रहता है, कई एक्सचेंज हाउस पुराने संदर्भ पर थोड़ा चौड़ा मार्जिन रख लेते हैं।',
      },
    ],
  },

  'sar-inr': {
    lead:
      'सऊदी रियाल 1986 से अमेरिकी डॉलर पर एक तय दर पर बँधा है, इसलिए SAR से INR में जो हलचल दिखती है वह असल में रुपये की हलचल होती है। '
      + 'रियाल को रुपये में बदलने का काम {{app}} करता है, जो कनेक्शन न मिलने पर आख़िरी सहेजे आँकड़े से चलता रहता है।',
    h2: 'रियाल से रुपया: नौकरी और ज़ियारत, दोनों का हिसाब',
    body: [
      'सऊदी अरब में बसे भारतीयों की संख्या बीस लाख से ऊपर है, और उनमें बड़ा हिस्सा काम के सिलसिले में वहाँ है। तनख़्वाह वेतन सुरक्षा प्रणाली के ज़रिए हर महीने एक तय तारीख़ पर सऊदी बैंक खाते में पहुँचती है। इसीलिए इस रास्ते पर पैसा महीने के कुछ ही दिनों में झुंड बनाकर चलता है। रियाद, जेद्दा और दम्माम के काउंटर उन्हीं दिनों सबसे व्यस्त होते हैं, और भीड़ जितनी बड़ी होती है, भाव पर मोलभाव की गुंजाइश उतनी ही कम रह जाती है।',
      'दूसरी दिशा उतनी ही अहम है, और यही इस जोड़ी को खाड़ी के बाक़ी रास्तों से अलग करती है: हज और उमरा। भारत का हज कोटा दुनिया के सबसे बड़े कोटों में गिना जाता है, और उमरा मिलाकर हर साल बड़ी संख्या में लोग रुपया लेकर रियाल की ज़रूरत में उतरते हैं। यहाँ सवाल भेजने का नहीं, ख़रीदने का होता है — भारत में रियाल के नोट लेना, फ़ॉरेक्स कार्ड में रकम भरवाना, या दोनों का मिलाजुला इंतज़ाम। हज समिति के रास्ते जाने वालों का बड़ा हिस्सा रुपये में ही जमा होता है, और बाक़ी ख़र्च वहीं रियाल में निकलता है।',
      'तय लंगर का मतलब यह है कि सऊदी की तरफ़ से कोई ख़बर इस भाव को नहीं छूती। जो कुछ बदलता है वह रुपये की तरफ़ से आता है, और जो कुछ आपकी जेब पर असर डालता है वह काउंटर का हिस्सा है। इसी वजह से रियाल ख़रीदते समय भाव के साथ यह भी पूछना चाहिए कि कमीशन अलग है या भाव में ही जोड़ दिया गया है — यही एक सवाल दो जगहों के बीच का असली फ़र्क़ खोल देता है।',
    ],
    tips: {
      h3: 'रियाल के साथ सफ़र और तनख़्वाह',
      items: [
        'रियाल का सौवाँ हिस्सा हलाला कहलाता है; चलन में 25 और 50 हलाला के सिक्के मिलते हैं।',
        'सऊदी अरब में दुकान पर लिखा दाम मूल्य वर्धित कर समेत होता है, यानी बिल में अलग से कुछ नहीं जुड़ता।',
        'नक़द रियाल पर ख़रीद-बिक्री का फैलाव आमतौर पर कार्ड से चौड़ा होता है; छोटी ख़रीद के लिए थोड़ा नक़द और बाक़ी कार्ड पर रखना सुविधाजनक पड़ता है।',
        'लंगर 1986 से टिका है, इसलिए इस जोड़ी का पाँच साल का चार्ट रियाल की नहीं, रुपये की कहानी दिखाता है।',
        'ज़ियारत के दिनों भीड़ में नेटवर्क कमज़ोर रहता है — {{app}} का ऑफ़लाइन हिसाब ठीक वहीं काम आता है।',
      ],
    },
    faq: [
      {
        q: 'हज या उमरा के लिए रुपया रियाल में कहाँ बदलवाना बेहतर है?',
        a: 'जहाँ भी बदलवाएँ, काउंटर के भाव को {{app}} के संदर्भ भाव से मिलाकर देखिए और कमीशन अलग से पूछिए। फ़ॉरेक्स कार्ड में रकम भरवाते ही भाव तय हो जाता है, जबकि नक़द नोट पर फैलाव आमतौर पर ज़्यादा चौड़ा रहता है।',
      },
      {
        q: 'सऊदी से घर पैसा भेजते समय सबसे ज़्यादा किस बात से फ़र्क़ पड़ता है?',
        a: 'भाव में छिपे मार्जिन से, क्योंकि रियाल की टाँग तय है। दो काउंटरों के भाव का अंतर पूरी तरह उनका अपना हिस्सा है, और उसके ऊपर हर बार लगने वाला निश्चित शुल्क अलग बैठता है।',
      },
    ],
  },

  'gbp-inr': {
    lead:
      'बड़ी मुद्राओं में पाउंड स्टर्लिंग रुपये के मुक़ाबले सबसे महँगा है, इसलिए GBP से INR बदलते समय दशमलव के बाद का फ़र्क़ भी बड़ी रकम बनाता है। '
      + 'फ़ीस भरते वक़्त यह आँकड़ा {{app}} जेब में ही निकालकर दे देता है, Android और iOS दोनों पर।',
    h2: 'पाउंड से रुपया: पढ़ाई, पुरानी बसावट और ख़रीदारी',
    body: [
      'ब्रिटेन में भारतीय छात्र विदेशी छात्रों के सबसे बड़े समूहों में गिने जाते हैं, और इस जोड़ी को सबसे ज़्यादा वही खोजते हैं। ट्यूशन फ़ीस, जमा राशि और आव्रजन स्वास्थ्य अधिभार — सब पाउंड में देना पड़ता है, और भारत से यह पैसा LRS के रास्ते जाता है। यहाँ एक कड़वी सच्चाई है: भुगतान की तारीख़ यूनिवर्सिटी तय करती है, बाज़ार नहीं। अच्छे भाव के इंतज़ार की गुंजाइश तब ख़त्म हो जाती है जब सीट पक्की करने की आख़िरी तारीख़ सिर पर हो।',
      'दूसरा तबका बहुत पुराना है। ब्रिटेन का भारतीय समुदाय पीढ़ियों से बसा है, और वहाँ से भारत आने वाला पैसा अक्सर तनख़्वाह का हिस्सा नहीं, बल्कि ज़मीन, इलाज, पेंशन या बुज़ुर्ग माता-पिता के ख़र्च से जुड़ा होता है। ऐसे भुगतान अनियमित और बड़े होते हैं, इसलिए इनमें भाव का असर एक ही बार में पूरा दिख जाता है। एक सुविधा यह भी है कि विश्व बाज़ार पाउंड को हमेशा आधार मानकर बोलता है, यानी ख़बरों में दिखने वाला आँकड़ा उसी दिशा में होता है जिस दिशा में भारतीय पाठक उसे पढ़ना चाहता है।',
      'घूमने और ख़रीदारी वालों के लिए दो बातें ध्यान देने लायक़ हैं। ब्रिटेन में दुकान पर लिखा दाम VAT समेत होता है, यानी बिल में अलग से कर नहीं जुड़ता। लेकिन जनवरी 2021 से ब्रिटेन ने विदेशी पर्यटकों को हाई स्ट्रीट ख़रीदारी पर VAT वापसी देना बंद कर दिया है, इसलिए हवाई अड्डे पर रिफ़ंड काउंटर ढूँढ़ने का कोई फ़ायदा नहीं — वह रकम अब लौटती ही नहीं, और उसे बजट में जोड़कर चलना ही समझदारी है।',
    ],
    tips: {
      h3: 'पाउंड में फ़ीस और ख़रीदारी',
      items: [
        'पाउंड का सौवाँ हिस्सा पेनी है — बहुवचन में पेंस — और चिह्न £ लिखा जाता है; बोलचाल का "क्विड" भी यही मुद्रा है।',
        'स्कॉटलैंड और उत्तरी आयरलैंड के बैंक अपने नोट जारी करते हैं — मुद्रा वही पाउंड है, पर भारत के कई मनी चेंजर ये नोट लेने से हिचकते हैं।',
        'फ़ीस की आख़िरी तारीख़ ही आपकी रूपांतरण तिथि तय करती है; भाव का इंतज़ार करने की योजना पहले से बनानी पड़ती है।',
        'दुकान का दाम VAT समेत है, और 2021 से पर्यटकों के लिए VAT वापसी बंद है।',
        'GBP/INR को {{app}} में पसंदीदा बना लें, ताकि क़िस्तों के बीच भाव पर नज़र बनी रहे।',
      ],
    },
    faq: [
      {
        q: 'ब्रिटेन की फ़ीस भेजते समय भाव के अलावा क्या देखना चाहिए?',
        a: 'बैंक के भाव में छिपा मार्जिन, स्विफ़्ट और मध्यस्थ बैंकों का शुल्क, LRS के तहत एक सीमा से ऊपर कटने वाला TCS, और यूनिवर्सिटी की अंतिम तारीख़। इन चारों का जोड़ अक्सर भाव के अंतर से बड़ा निकलता है।',
      },
      {
        q: 'क्या स्कॉटलैंड के नोट भारत में बदले जा सकते हैं?',
        a: 'मुद्रा वही पाउंड है और भाव भी वही, लेकिन भारत के कई काउंटर इन नोटों से परिचित नहीं होते और लेने से मना कर देते हैं। लौटते समय बैंक ऑफ़ इंग्लैंड के नोट साथ रखना ज़्यादा व्यावहारिक है।',
      },
    ],
  },

  'eur-inr': {
    lead:
      'यूरो यूरोपीय संघ के ज़्यादातर देशों की साझा मुद्रा है, इसलिए EUR से INR का एक ही भाव पूरे यूरोज़ोन की फ़ीस, बुकिंग और ख़र्च पर लागू होता है। '
      + 'रुपये में कितना बैठा, यह {{app}} बता देता है — रोमिंग बंद रखी हो तब भी।',
    h2: 'यूरो से रुपया: पढ़ाई, वीज़ा और निर्यात के बिल',
    body: [
      'यूरोपीय संघ में भारतीय छात्रों का सबसे बड़ा ठिकाना जर्मनी है, और वहाँ की सार्वजनिक यूनिवर्सिटी में ट्यूशन फ़ीस लगभग नहीं होती — पर वीज़ा से पहले एक अवरुद्ध खाता भरना पड़ता है, जिसकी रकम हर साल दोबारा तय होती है। इसका मतलब यह है कि यहाँ ट्रांसफ़र महीने-महीने की छोटी धार नहीं, बल्कि तारीख़ से बँधी एक बड़ी रकम होती है, और उसी एक दिन का भाव पूरे साल के बजट पर बैठ जाता है।',
      'दूसरा कारण शेंगेन वीज़ा है। आवेदन के साथ होटल की बुकिंग, यात्रा बीमा और खाते में पर्याप्त रकम का सबूत माँगा जाता है, और ये सब यूरो में गिने जाते हैं। यहाँ यूरो की सबसे बड़ी सुविधा भी है और सबसे बड़ी ग़लतफ़हमी भी: यूरोपीय संघ के ज़्यादातर देशों में एक ही मुद्रा चलती है, पर पूरे यूरोप में नहीं — स्विट्ज़रलैंड, ब्रिटेन, पोलैंड, चेकिया, हंगरी और स्कैंडिनेविया के देश अपनी अलग मुद्रा रखते हैं। एक ही यात्रा में सीमा पार करते ही दूसरा हिसाब शुरू हो जाता है।',
      'तीसरा तबका कारोबारी है। यूरोपीय ख़रीदार को यूरो में बिल भेजने वाले भारतीय निर्यातक के लिए रुपया उस दिन बनता है जिस दिन पैसा आता है, बिल की तारीख़ पर नहीं। बीच के हफ़्तों में भाव जितना खिसकता है, वह मुनाफ़े में से सीधे कटता है — इसीलिए तय दाम वाला सौदा चुपचाप एक मुद्रा जोखिम भी बन जाता है। घूमने वालों के लिए इसका छोटा संस्करण दुकान की मशीन पर मिलता है, जब वह रुपये में बिल बनाने की पेशकश करती है; वह सुविधा नहीं, दुकान की तरफ़ से लगाया गया अपना भाव है।',
    ],
    tips: {
      h3: 'यूरोप में दाम पढ़ने का तरीक़ा',
      items: [
        'यूरोप में दाम अक्सर "1.234,56" शैली में लिखा जाता है — बिंदु हज़ार अलग करता है और अल्पविराम दशमलव, यानी भारत की आदत से ठीक उल्टा।',
        'यूरो का सौवाँ हिस्सा सेंट है और चिह्न € लिखा जाता है; कई देशों में यह अंक के बाद आता है।',
        'यूरोपीय दुकानों का लिखा दाम कर समेत होता है, इसलिए बदला हुआ आँकड़ा ही असली ख़र्च है।',
        'मशीन रुपये में बिल बनाने की पेशकश करे तो मना कर दीजिए और यूरो में ही भुगतान कीजिए।',
        'ट्रेन और मेट्रो के नीचे नेटवर्क गिरता है — {{app}} वहीं आख़िरी सहेजे भाव से हिसाब देता रहता है।',
      ],
    },
    faq: [
      {
        q: 'क्या पूरे यूरोप में यूरो चलता है?',
        a: 'नहीं। यूरो यूरोपीय संघ के ज़्यादातर देशों की साझा मुद्रा है, और यूरोप के कई देश इससे बाहर हैं — स्विट्ज़रलैंड फ़्रैंक चलाता है, ब्रिटेन पाउंड, पोलैंड ज़्लॉटी, चेकिया कोरुना, हंगरी फ़ोरिंट और स्कैंडिनेविया अपनी क्रोना। कई देशों की यात्रा में एक से ज़्यादा हिसाब लगेगा।',
      },
      {
        q: 'यूरोप में "1.234,56" लिखा दाम कितना हुआ?',
        a: 'वह एक हज़ार दो सौ चौंतीस और उसके बाद छप्पन सौवाँ हिस्सा है, यानी भारतीय शैली में 1,234.56 लिखा जाएगा। यूरोप की ज़्यादातर जगहों पर बिंदु हज़ार का विभाजक है और अल्पविराम दशमलव — भारत में यही उल्टा चलता है, इसलिए आँकड़ा पढ़ते समय सबसे पहले यही देखिए।',
      },
    ],
  },

  'cad-inr': {
    lead:
      'कनाडाई डॉलर और अमेरिकी डॉलर एक ही चिह्न साझा करते हैं, पर CAD से INR का भाव USD से INR वाले भाव से हमेशा अलग रहता है। '
      + '{{app}} में ये दो अलग प्रविष्टियाँ हैं और कभी आपस में नहीं मिलतीं, इसलिए ग़लत डॉलर चुन लेने की गुंजाइश नहीं बचती।',
    h2: 'कनाडाई डॉलर से रुपया: छात्र, GIC और परिवार',
    body: [
      'कनाडा भारतीय छात्रों का सबसे बड़ा ठिकाना रहा है, और इस जोड़ी का सबसे बड़ा एक-मुश्त लेनदेन भी वहीं से आता है। अध्ययन परमिट के आवेदन में रहने-खाने के ख़र्च का सबूत देना होता है, और उसका एक बहुत आम रास्ता है वीज़ा से पहले गारंटीड इन्वेस्टमेंट सर्टिफ़िकेट यानी GIC ख़रीदना। यह रकम हर साल संशोधित होती है, और इसे भरने की तारीख़ भी तय होती है — यानी एक बड़ी रकम, एक ही दिन, और भाव चुनने की कोई छूट नहीं।',
      'दूसरी तरफ़ पंजाब और गुजरात से गई पुरानी बसावट है, जिससे यह रास्ता दोनों दिशाओं में चलता है। शुरुआती सालों में माता-पिता बच्चों को पैसा भेजते हैं; कुछ बरस बाद वही बच्चे स्थायी निवास पाकर घर पैसा भेजने लगते हैं। दोनों टाँगों पर बैंक का मार्जिन अलग-अलग बैठता है, इसलिए एक ही परिवार दोनों तरफ़ अलग-अलग हिसाब देखता है। सिक्कों के नाम भी वहाँ अलग हैं — एक डॉलर वाले को "लूनी" और दो डॉलर वाले को "टूनी" कहा जाता है।',
      'क़ीमत पढ़ने की आदत यहाँ सबसे ज़्यादा धोखा देती है। भारत में पैकेट पर छपा एमआरपी सारे कर मिलाकर होता है, इसलिए भारतीय आँख शेल्फ़ के दाम को आख़िरी दाम मान लेती है। कनाडा में बिक्री कर बिल बनते समय ऊपर से जुड़ता है और हर प्रांत में अलग है — अल्बर्टा में प्रांतीय बिक्री कर है ही नहीं, जबकि दूसरे प्रांतों में यह ठीक-ठाक जुड़ जाता है। ऊपर से रेस्तराँ और टैक्सी में टिप का चलन है, जो भारत में उतना सख़्त नहीं। कनाडाई डॉलर की चाल कच्चे तेल के भाव से भी जुड़ी है, क्योंकि तेल वहाँ के निर्यात का बड़ा हिस्सा है।',
    ],
    tips: {
      h3: 'कनाडा जाने से पहले जान लें',
      items: [
        'दाम के आगे CA$ या C$ लिखा हो तो वह कनाडाई है; सिर्फ़ $ देखकर अमेरिकी मान लेना महँगा पड़ता है।',
        'शेल्फ़ का दाम आख़िरी दाम नहीं — बिक्री कर बिल पर जुड़ता है, और दर प्रांत के हिसाब से बदलती है।',
        'रेस्तराँ और टैक्सी में टिप का चलन है, इसलिए बदला हुआ बिल भी पूरा ख़र्च नहीं होता।',
        'GIC और पहली किश्त की फ़ीस मिलाकर एक बड़ा ट्रांसफ़र बनता है; बैंक से बुक किया गया भाव सलाह पर लिखवा लीजिए।',
        'कच्चे तेल की ख़बरें इस मुद्रा को हिलाती हैं, इसलिए चाल कभी-कभी ऊर्जा बाज़ार से आती है।',
      ],
    },
    faq: [
      {
        q: 'GIC के लिए पैसा भेजते समय भाव कब तय होता है?',
        a: 'उस दिन, जिस दिन बैंक रूपांतरण बुक करता है — आवेदन शुरू करने के दिन नहीं। बुकिंग के बाद मिलने वाली सलाह पर लगाया गया भाव लिखा रहता है, और उसी को {{app}} के संदर्भ भाव से मिलाकर असली लागत निकाली जा सकती है।',
      },
      {
        q: 'कनाडा में दुकान का दाम आख़िरी दाम क्यों नहीं होता?',
        a: 'भारत में एमआरपी कर समेत छपता है, जबकि कनाडा में बिक्री कर बिल बनते समय जोड़ा जाता है और प्रांत के हिसाब से बदलता है। इसलिए शेल्फ़ के दाम को बदलकर देखा गया आँकड़ा हमेशा कम बैठता है।',
      },
    ],
  },

  'aud-inr': {
    lead:
      'ऑस्ट्रेलियाई डॉलर एक कमोडिटी मुद्रा है, इसलिए AUD से INR का भाव लोहा, कोयला और एशिया की माँग की ख़बरों पर भी हिलता है। '
      + 'बदलने का काम {{app}} करता है, जो आउटबैक के लंबे सूने रास्तों पर, सिग्नल गिर जाने के बाद भी आँकड़ा दिखाता रहता है।',
    h2: 'ऑस्ट्रेलियाई डॉलर से रुपया: पढ़ाई, हुनर और समय-क्षेत्र',
    body: [
      'ऑस्ट्रेलिया में भारत में जन्मे लोगों की आबादी सबसे तेज़ी से बढ़ने वाले समूहों में है, और मेलबर्न तथा सिडनी में यह समुदाय बहुत घना है। यहाँ का ढाँचा दूसरे रास्तों से थोड़ा अलग है: पहले छात्र आते हैं, फिर स्नातक वीज़ा पर काम, फिर हुनर आधारित स्थायी निवास। इसीलिए इस जोड़ी को देखने वाला अक्सर एक ही व्यक्ति होता है, पर हर दो-तीन साल में अलग वजह से — कभी फ़ीस भरने के लिए, कभी घर पैसा भेजने के लिए।',
      'समय-क्षेत्र इस जोड़ी की सबसे कम समझी जाने वाली बात है। सिडनी का विदेशी मुद्रा सत्र दुनिया में सबसे पहले खुलने वालों में है, भारत के काम शुरू करने से कई घंटे पहले। इसका नतीजा यह होता है कि सुबह नौ बजे भारत में जो भाव दिखता है, वह पहले ही बदल चुका होता है — वह ताज़ा ख़बर नहीं, रात भर की चाल का नतीजा है। जिन्हें बड़ी रकम भेजनी हो, उनके लिए यह अंतर मायने रखता है।',
      'भाव की चाल भी भारतीय या ऑस्ट्रेलियाई घरेलू ख़बरों से कम, और लोहे-कोयले की माँग से ज़्यादा जुड़ी है। ऑस्ट्रेलिया की कमाई का बड़ा हिस्सा कच्चे माल के निर्यात से आता है, इसलिए एशिया में औद्योगिक माँग घटने-बढ़ने पर यह मुद्रा हिलती है। यही वजह है कि यह जोड़ी महीनों तक शांत रहकर अचानक तेज़ चल सकती है। एक और छोटी बात: ऑस्ट्रेलिया दुनिया का पहला देश था जिसने अपने सारे नोट प्लास्टिक यानी पॉलिमर पर छापे, इसलिए वहाँ के नोट भीगने पर भी ख़राब नहीं होते।',
    ],
    tips: {
      h3: 'ऑस्ट्रेलिया में ख़र्च का अंदाज़ा',
      items: [
        'वहाँ लिखा दाम वस्तु एवं सेवा कर समेत होता है, यानी बिल पर कुछ और नहीं जुड़ता।',
        'टिप देने का रिवाज़ नहीं है, इसलिए बदला हुआ बिल ही पूरा ख़र्च है।',
        'दाम के आगे A$ लिखा हो तो वह ऑस्ट्रेलियाई डॉलर है; अमेरिकी डॉलर से भ्रम यहीं होता है।',
        'यह मुद्रा घरेलू आँकड़ों से ज़्यादा कच्चे माल की माँग पर चलती है, इसलिए ख़बर कहीं और की होती है और असर यहाँ दिखता है।',
        'लंबे रास्तों पर नेटवर्क नहीं मिलता; {{app}} का ऑफ़लाइन हिसाब वहीं सबसे काम आता है।',
      ],
    },
    faq: [
      {
        q: 'ऑस्ट्रेलिया में दाम पर कर अलग से लगता है?',
        a: 'नहीं। वहाँ लिखा दाम वस्तु एवं सेवा कर समेत होता है, इसलिए बदला हुआ आँकड़ा ही चुकाने वाली रकम है। यह अमेरिका और कनाडा से उल्टा है, जहाँ बिक्री कर बिल बनते समय जुड़ता है।',
      },
      {
        q: 'भारत में सुबह देखने पर AUD/INR पहले से बदला हुआ क्यों लगता है?',
        a: 'क्योंकि सिडनी का सत्र भारत के दफ़्तरी दिन से कई घंटे पहले खुल जाता है। भारत में दफ़्तर खुलने तक ऑस्ट्रेलियाई डॉलर पर रात भर की चाल पहले ही दर्ज हो चुकी होती है।',
      },
    ],
  },

  'sgd-inr': {
    lead:
      'SGD से INR बदलने पर एक सिंगापुर डॉलर कई दर्जन भारतीय रुपये देता है। '
      + 'यह भाव उस असामान्य नीति से बनता है जिसमें सिंगापुर ब्याज दर की जगह विनिमय दर चलाता है, और वही भाव {{app}} में बिना नेटवर्क भी हाथ में रहता है।',
    h2: 'सिंगापुर डॉलर से रुपया: नौकरी, UPI और "++" वाला बिल',
    body: [
      'सिंगापुर में भारतीय मूल की आबादी सदियों पुरानी है — तमिल वहाँ की चार आधिकारिक भाषाओं में से एक है — और उसके ऊपर रोज़गार पास तथा एस पास पर काम करने वाले पेशेवरों की एक नई परत है। इसीलिए यह रास्ता खाड़ी के रास्तों जैसा नहीं है: यहाँ भेजने वाला अक्सर परिवार का ख़र्च नहीं, बल्कि भारत में चल रही किश्त, निवेश या माता-पिता का ख़ाता भरता है, और रकम छोटी-छोटी बार-बार जाती है।',
      'सिंगापुर की मौद्रिक नीति दुनिया में लगभग अनोखी है। वहाँ का केंद्रीय प्राधिकरण ब्याज दर के बजाय विनिमय दर को औज़ार बनाता है और सिंगापुर डॉलर को एक अघोषित मुद्रा-टोकरी के मुक़ाबले तय पट्टी में रखता है। इसका सीधा असर यह है कि सिंगापुर की तरफ़ से आने वाली नीतिगत ख़बरें ब्याज दर की भाषा में नहीं आतीं, और उन्हें पढ़ना दूसरे देशों की ख़बरों से अलग हुनर माँगता है। समीक्षा की तारीख़ें पहले से घोषित होती हैं, और असर उसी दिन दिखता है।',
      'भेजने के तरीक़े में भी यह रास्ता आगे है। फ़रवरी 2023 में भारत की UPI और सिंगापुर की PayNow व्यवस्था आपस में जोड़ी गईं, जिससे दोनों देशों के बीच सीधे मोबाइल नंबर पर पैसा भेजा जा सकता है, और हर बैंक अपनी सीमा तय करता है। सुविधा असली है, पर भाव अपने आप बेहतर नहीं हो जाता — जुड़ाव सिर्फ़ बीच की कड़ियाँ घटाता है, बैंक का मार्जिन नहीं। घूमने वालों के लिए एक और बात: सिंगापुर पर्यटकों को कर वापसी की सुविधा देता है, बशर्ते ख़रीद और निकासी दोनों नियम के मुताबिक़ दर्ज हों।',
    ],
    tips: {
      h3: 'सिंगापुर का बिल और भेजने का रास्ता',
      items: [
        'मेन्यू पर दाम के आगे "++" का मतलब है कि उसके ऊपर सेवा शुल्क और कर दोनों जुड़ेंगे — मेन्यू का आँकड़ा बदलना बेकार है, आख़िरी बिल बदलिए।',
        'सिंगापुर डॉलर और ब्रुनेई डॉलर 1967 के समझौते के तहत बराबरी पर स्वीकार किए जाते हैं; दुकानों में दोनों चल जाते हैं।',
        'नीतिगत समीक्षा की तारीख़ें पहले से तय रहती हैं, और वही इस मुद्रा को हिलाती हैं, न कि ब्याज दर की घोषणाएँ।',
        'UPI–PayNow जुड़ाव कड़ियाँ घटाता है; भाव फिर भी बैंक का अपना होता है, इसलिए मिलाकर देखिए।',
        'इस जोड़ी को {{app}} में पसंदीदा बनाकर रखें, तो हर किश्त से पहले भाव सामने रहेगा।',
      ],
    },
    faq: [
      {
        q: 'सिंगापुर के मेन्यू में "++" का क्या मतलब है?',
        a: 'पहला जोड़ सेवा शुल्क का है और दूसरा वस्तु एवं सेवा कर का। दोनों दाम के ऊपर लगते हैं, इसलिए मेन्यू पर लिखी रकम को बदलकर देखने से असली ख़र्च कम दिखता है; आख़िरी बिल का आँकड़ा ही बदलिए।',
      },
      {
        q: 'क्या UPI–PayNow जुड़ाव से भाव सस्ता मिलता है?',
        a: 'ज़रूरी नहीं। यह जुड़ाव भेजने की प्रक्रिया छोटी करता है, पर रूपांतरण भाव और शुल्क हर बैंक अपने हिसाब से तय करता है। भेजने से पहले उस भाव को {{app}} के संदर्भ भाव से मिलाना ही असली तुलना है।',
      },
    ],
  },

  'kwd-inr': {
    lead:
      'कुवैती दिनार दुनिया की सबसे ऊँची इकाई वाली मुद्रा है और इसमें तीन दशमलव चलते हैं, इसलिए KWD से INR बदलने पर आँकड़ा बहुत बड़ा निकलता है। '
      + 'दिनार को रुपये में {{app}} बदलता है, और उसमें दशमलव के अंक बढ़ाकर तीन किए जा सकते हैं, जो इस जोड़ी में ज़रूरी है।',
    h2: 'दिनार से रुपया: तीन दशमलव वाली जोड़ी',
    body: [
      'कुवैत में भारतीय सबसे बड़ा प्रवासी समुदाय हैं, और वहाँ से घर आने वाला पैसा खाड़ी के सबसे पुराने रास्तों में से एक है। पैसा भेजने की लय वही है जो बाक़ी खाड़ी देशों की है, पर हिसाब की लय अलग है, और वजह दिनार की बनावट में छिपी है। एक और बात जो पुराने लोग याद रखते हैं: 1991 में हालात बदलने के बाद कुवैत ने अपने नोटों की पूरी शृंखला रद्द करके नई जारी की थी, इसलिए बहुत पुराने दिनार नोट आज किसी काम के नहीं।',
      'दिनार का हज़ारवाँ हिस्सा फ़िल्स कहलाता है, यानी इसका ISO 4217 घातांक तीन है, दो नहीं। इसका नतीजा रोज़ के लेनदेन में दिखता है: भाव तीसरे दशमलव तक लिखा जाता है, और वहाँ का अंतर कोई गोलमाल नहीं, असली पैसा होता है। जो कन्वर्टर या दुकानदार आदतन दो दशमलव पर काट देता है, वह पूरी तनख़्वाह के पैमाने पर ठीक-ठाक रकम खा जाता है। यही वजह है कि इस जोड़ी में दशमलव की सेटिंग कोई सजावट नहीं, ज़रूरत है।',
      'दूसरी ख़ास बात लंगर की है। कुवैत ने 2007 में अकेले डॉलर से जुड़ाव छोड़कर दिनार को मुद्राओं की एक भारित टोकरी से बाँधा, और उस टोकरी का वज़न सार्वजनिक नहीं है। इसका मतलब यह है कि दिरहम और रियाल के उलट दिनार डॉलर के मुक़ाबले थोड़ा-बहुत खिसक सकता है, पर बाहर बैठा कोई व्यक्ति इसका हिसाब ख़ुद नहीं लगा सकता — यह भाव पढ़ा जाता है, निकाला नहीं जाता। इसीलिए यहाँ अनुमान लगाने के बजाय हर बार ताज़ा आँकड़ा देख लेना ही सही तरीक़ा है।',
    ],
    tips: {
      h3: 'दिनार गिनते समय',
      items: [
        'दिनार का हज़ारवाँ हिस्सा फ़िल्स है, इसलिए भाव तीन दशमलव तक लिखा जाता है — दो पर काटना घाटा है।',
        '{{app}} में दशमलव के अंक बढ़ाकर तीन कर लीजिए, वरना छोटी रकमों में तीसरा अंक ग़ायब हो जाएगा।',
        'लंगर 2007 से मुद्राओं की एक अघोषित टोकरी से है, अकेले डॉलर से नहीं; इसलिए यह भाव खाड़ी की बाक़ी मुद्राओं जितना जड़ नहीं है।',
        'ऊँची इकाई का मतलब है कि छोटी सी दिनार रकम भी रुपये में बड़ी बैठती है — भेजने से पहले अंक गिन लीजिए।',
        'हर बार का तय शुल्क रकम के साथ नहीं बढ़ता, इसलिए महीने में एक बार भेजना टुकड़ों से सस्ता पड़ता है।',
      ],
    },
    faq: [
      {
        q: 'कुवैती दिनार में तीन दशमलव क्यों होते हैं?',
        a: 'क्योंकि दिनार को हज़ार फ़िल्स में बाँटा गया है, और ISO 4217 में इसका घातांक तीन है। दुनिया की ज़्यादातर मुद्राएँ सौ हिस्सों में बँटती हैं, इसलिए दो दशमलव की आदत यहाँ ग़लत नतीजा देती है।',
      },
      {
        q: 'क्या कुवैती दिनार भी डॉलर से बँधा हुआ है?',
        a: 'सीधे नहीं। 2007 से दिनार का लंगर मुद्राओं की एक भारित टोकरी है, जिसके अनुपात कुवैत का केंद्रीय बैंक सार्वजनिक नहीं करता। इसीलिए यह डॉलर के मुक़ाबले थोड़ा खिसकता है, जबकि दिरहम और रियाल टस से मस नहीं होते।',
      },
    ],
  },

  'qar-inr': {
    lead:
      'एक क़तरी रियाल कई भारतीय रुपये देता है, और चूँकि रियाल 2001 से डॉलर पर एक तय दर पर बँधा है, इस जोड़ी की चाल पूरी तरह रुपये पर टिकी है। '
      + 'रुपये में कितना बना, यह {{app}} गिन देता है — दोहा में सिम बदलने वाले उन दिनों में भी, जब नंबर चालू नहीं होता।',
    h2: 'क़तरी रियाल से रुपया: दोहा का महीना-दर-महीना हिसाब',
    body: [
      'क़तर में भारतीय सबसे बड़ा प्रवासी समुदाय हैं, और गैस तथा निर्माण से चलने वाली उस अर्थव्यवस्था में तनख़्वाह का चक्र बहुत नियमित है। 2022 के विश्व कप के लिए बने ढाँचे ने कामगारों की संख्या को कई साल तक ऊँचा रखा, और उसी अनुपात में दोहा से भारत जाने वाला पैसा भी। यहाँ भी लय वही है: महीने के आख़िर में खाता भरता है, और अगले कुछ दिनों में काउंटर व्यस्त रहते हैं।',
      'इस जोड़ी का सबसे मज़ेदार पेच नाम का है। क़तरी रियाल का सौवाँ हिस्सा "दिरहम" कहलाता है — वही शब्द जो पड़ोस में एक पूरी मुद्रा का नाम है। इसलिए क़तर में "दिरहम" सुनकर अमीरात वाली मुद्रा समझ लेना आसान भूल है, और यह भूल छोटे लेनदेन में सीधे रकम पर बैठती है। नए लोगों को पहले हफ़्ते में यही सबसे ज़्यादा उलझाता है।',
      'इतिहास भारत से जुड़ा हुआ है, और यह इस पेज का सबसे कम जाना हुआ तथ्य है। खाड़ी के इन इलाक़ों में एक ज़माने में भारतीय रिज़र्व बैंक का जारी किया "गल्फ़ रुपया" चलता था, जो ख़ास तौर पर वहीं के लिए छापा जाता था। साठ के दशक में ये इलाक़े अपनी मुद्रा पर चले गए, और क़तर ने पड़ोसी के साथ मिलकर अलग रियाल जारी किया। आज का तय लंगर 2001 से है। 2017 से 2021 के नाकेबंदी वाले दौर में देश के बाहर मिलने वाले भाव कुछ समय के लिए आधिकारिक दर से भटके भी थे, जबकि क़तर के भीतर दर वही बनी रही — यह याद दिलाता है कि तय दर देश के भीतर की व्यवस्था है, दुनिया भर का वादा नहीं।',
    ],
    tips: {
      h3: 'दोहा से भेजते वक़्त',
      items: [
        'रियाल का सौवाँ हिस्सा "दिरहम" कहलाता है — नाम अमीरात की मुद्रा जैसा है, पर चीज़ बिल्कुल अलग है।',
        'लंगर 2001 से तय है, इसलिए भाव में जो हलचल दिखे वह रुपये की तरफ़ से आती है।',
        'क़तर में सप्ताहांत शुक्रवार-शनिवार का है, और उन दिनों अंतर-बैंक बाज़ार सुस्त रहता है; भेजने के लिए कामकाजी दिन बेहतर हैं।',
        'दो काउंटरों के बीच का पूरा अंतर मार्जिन है — भाव के साथ कमीशन अलग से पूछ लीजिए।',
        'भाव {{app}} में सहेजकर कुछ दिन की तुलना कर लेने से यह अंतर साफ़ दिखने लगता है।',
      ],
    },
    faq: [
      {
        q: 'क़तर का "दिरहम" और अमीरात का दिरहम एक ही चीज़ हैं?',
        a: 'नहीं। क़तर में दिरहम रियाल का सौवाँ हिस्सा है, यानी एक छोटी इकाई। अमीरात में दिरहम पूरी मुद्रा का नाम है, जिसका कोड AED है। नाम एक जैसा है, मूल्य नहीं।',
      },
      {
        q: 'क्या खाड़ी में कभी भारतीय रुपया चलता था?',
        a: 'हाँ। भारतीय रिज़र्व बैंक ने खाड़ी के इलाक़ों के लिए अलग से "गल्फ़ रुपया" जारी किया था, जो वहाँ प्रचलन में था। साठ के दशक में ये देश अपनी-अपनी मुद्रा पर चले गए, और क़तर ने रियाल अपनाया।',
      },
    ],
  },

  'myr-inr': {
    lead:
      'मलेशियाई रिंगिट देश के बाहर खुलकर कारोबार नहीं करता, इसलिए भारत में रिंगिट के नोट मुश्किल से मिलते हैं और असली बदलाव आमतौर पर मलेशिया पहुँचकर होता है। '
      + 'रिंगिट का हिसाब {{app}} में होता है, जो उन गलियों में भी चलता रहता है जहाँ सिग्नल नहीं पहुँचता।',
    h2: 'रिंगिट से रुपया: घूमने वाले, बसे हुए और तेल का भाव',
    body: [
      'मलेशिया में भारतीय मूल की आबादी भारत के बाहर की सबसे बड़ी बसावटों में से एक है, ज़्यादातर तमिल भाषी, जो औपनिवेशिक दौर के बाग़ान-मज़दूरों की पीढ़ियाँ हैं। इसके अलावा दिसंबर 2023 से भारतीय पासपोर्ट रखने वालों के लिए वहाँ प्रवेश की शर्तें बहुत आसान कर दी गईं, जिसके बाद कुआलालंपुर, पेनांग और लंकावी जाने वालों की संख्या तेज़ी से बढ़ी। बातू केव्स और थाईपुसम की वजह से यह तीर्थ का रास्ता भी है, इसलिए भीड़ त्योहारों के हिसाब से बनती-बिगड़ती है।',
      'सबसे काम की बात रिंगिट के चरित्र में है। मलेशिया का केंद्रीय बैंक रिंगिट का देश के बाहर कारोबार नहीं होने देता, इसलिए इसका कोई बड़ा विदेशी बाज़ार नहीं है। भारत के मनी चेंजर या तो रिंगिट रखते ही नहीं, या रखते हैं तो ख़रीद-बिक्री का फैलाव बहुत चौड़ा होता है। व्यावहारिक रास्ता यह है कि फ़ॉरेक्स कार्ड या कोई बड़ी मुद्रा लेकर जाइए और मलेशिया में लाइसेंसी काउंटर पर बदलवाइए — और वहाँ भी हवाई अड्डे के काउंटर आमतौर पर शहर के काउंटरों से कमज़ोर भाव देते हैं।',
      'भाव की चाल पर दो चीज़ों का असर सबसे साफ़ है: पाम तेल और ऊर्जा। मलेशिया दोनों का बड़ा निर्यातक है, इसलिए इनके दाम गिरने-चढ़ने पर रिंगिट भी हिलता है। एक पुरानी याद भी लोगों के मन में अटकी रहती है: एशियाई संकट के बाद 1998 से 2005 तक रिंगिट डॉलर पर तय कर दिया गया था। वह दौर कब का ख़त्म हो चुका है और आज यह मुद्रा बाज़ार के साथ चलती है, इसलिए "इसका तो भाव फ़िक्स है" वाली धारणा अब सही नहीं। नक़द में एक और बात याद रखने लायक़ है: एक सेन का सिक्का चलन से हटा दिया गया, इसलिए नक़द बिल को पास के पाँच सेन तक गोल कर दिया जाता है, जबकि कार्ड से भुगतान में पूरी रकम ली जाती है।',
    ],
    tips: {
      h3: 'मलेशिया में नक़दी का इंतज़ाम',
      items: [
        'रिंगिट को दाम में RM लिखा जाता है और इसका सौवाँ हिस्सा सेन कहलाता है।',
        'भारत में रिंगिट लेने के बजाय फ़ॉरेक्स कार्ड या कोई बड़ी मुद्रा ले जाना आमतौर पर सस्ता पड़ता है।',
        'हवाई अड्डे के काउंटर से थोड़ा ही बदलवाइए और बाक़ी शहर के लाइसेंसी काउंटर पर — फ़र्क़ आमतौर पर साफ़ दिखता है।',
        'नक़द बिल पास के पाँच सेन तक गोल होता है, कार्ड वाला बिल नहीं; छोटी ख़रीद में यही अंतर दिखता है।',
        'भारतीय नोट विदेश में नहीं चलते और उन्हें देश से बाहर ले जाने पर सीमा भी है, इसलिए रुपया साथ ले जाने की योजना काम नहीं आती।',
      ],
    },
    faq: [
      {
        q: 'भारत में रिंगिट आसानी से क्यों नहीं मिलता?',
        a: 'क्योंकि मलेशिया अपनी मुद्रा का कारोबार देश के बाहर नहीं होने देता, इसलिए इसका कोई बड़ा विदेशी बाज़ार नहीं है। भारतीय काउंटर इसे कम रखते हैं और रखते भी हैं तो ख़रीद-बिक्री का फैलाव चौड़ा होता है।',
      },
      {
        q: 'क्या मलेशिया में भारतीय रुपये चल जाते हैं?',
        a: 'नहीं। भारतीय नोट विदेश में विनिमय योग्य नहीं हैं और वहाँ के काउंटर इन्हें आम तौर पर नहीं लेते। कार्ड या किसी बड़ी मुद्रा के साथ जाना और मलेशिया पहुँचकर रिंगिट लेना ही व्यावहारिक रास्ता है।',
      },
    ],
  },

  'npr-inr': {
    lead:
      'नेपाली रुपया 1993 से भारतीय रुपये के साथ तय दर पर बँधा है, इसलिए NPR से INR का भाव सालों-साल लगभग एक जैसा रहता है। '
      + 'नोट गिनने का काम {{app}} कर देता है, ट्रेक के उन हिस्सों में भी जहाँ टावर नहीं पहुँचता।',
    h2: 'नेपाली रुपये से भारतीय रुपया: खुली सीमा और तय दर',
    body: [
      'यह इस सूची की अकेली जोड़ी है जिसमें भाव पर नज़र रखने का कोई मतलब नहीं। नेपाल राष्ट्र बैंक ने 1993 से नेपाली रुपये को भारतीय रुपये के साथ एक तय दर पर बाँध रखा है, और तब से यह दर वहीं है। इसका सीधा नतीजा यह है कि इस जोड़ी का चार्ट सीधी लकीर जैसा दिखता है, और "आज भाव क्या है" पूछने का कोई फ़ायदा नहीं। पूछने लायक़ सवाल सिर्फ़ एक है: काउंटर कितना कमीशन काट रहा है।',
      'दूसरी ख़ास बात सीमा की है। भारत और नेपाल के नागरिक बिना वीज़ा एक-दूसरे के यहाँ आते-जाते हैं, और नेपाल में भारतीय नोट खुलकर चलते भी हैं। लेकिन एक शर्त है जो हर मौसम में लोगों को फँसाती है: नेपाल में भारतीय नोट सिर्फ़ सौ रुपये तक की क़ीमत वाले मान्य हैं। दो सौ, पाँच सौ और उससे बड़े भारतीय नोट वहाँ न ले जाए जा सकते हैं, न चलाए जा सकते हैं — और यह बात सुनौली या रक्सौल पहुँचने के बाद पता चलना महँगा पड़ता है।',
      'तीसरी परत मज़दूरी की है। नेपाल से बड़ी संख्या में लोग भारत में काम करते हैं और घर पैसा भेजते हैं, अक्सर सीमा पार नक़द या बैंकिंग चैनल से। तय दर की वजह से यहाँ पूरी लागत कमीशन में है, बाज़ार में नहीं — इसीलिए सीमा के बाज़ार की एक दुकान और काठमांडू का बैंक एक ही नोटों के बदले अलग-अलग रकम थमा सकते हैं। रसीद पढ़ते समय एक और बात चौंकाती है: नेपाल की तारीख़ विक्रम संवत में लिखी जाती है, इसलिए बिल पर छपा साल भारत के कैलेंडर से मेल नहीं खाएगा।',
    ],
    tips: {
      h3: 'सीमा पार करने से पहले',
      items: [
        'नेपाल में सिर्फ़ सौ रुपये तक के भारतीय नोट मान्य हैं; बड़े नोट साथ ले जाना बेकार भी है और जोखिम भरा भी।',
        'दर 1993 से तय है, इसलिए "अच्छे भाव" का इंतज़ार बेमानी है — कमीशन और सेवा शुल्क पूछिए।',
        'दोनों देशों में लाख और करोड़ की गिनती एक जैसी चलती है, इसलिए बड़े आँकड़े पढ़ने में यहाँ भ्रम नहीं होता।',
        'दोनों मुद्राओं के नाम और चिह्न मिलते-जुलते हैं; बिल या मेन्यू पर देखिए कि वह किस देश का रुपया है।',
        'पहाड़ी रास्तों और ट्रेकिंग में सिग्नल गिरता है, इसलिए {{app}} का ऑफ़लाइन हिसाब यहाँ रोज़ काम आता है।',
      ],
    },
    faq: [
      {
        q: 'नेपाल में भारतीय रुपये चलते हैं क्या?',
        a: 'हाँ, पर सिर्फ़ सौ रुपये तक की क़ीमत वाले नोट। दो सौ और पाँच सौ जैसे बड़े भारतीय नोट वहाँ मान्य नहीं हैं, इसलिए यात्रा से पहले छोटे नोट रख लेना या लाइसेंसी काउंटर से नेपाली रुपये ले लेना ही सही रास्ता है।',
      },
      {
        q: 'NPR/INR का भाव बदलता क्यों नहीं?',
        a: 'क्योंकि नेपाल राष्ट्र बैंक ने 1993 से नेपाली रुपये को भारतीय रुपये के साथ एक तय दर पर बाँध रखा है। दो काउंटरों के बीच जो अंतर दिखता है वह बाज़ार की चाल नहीं, उनका कमीशन और सेवा शुल्क होता है।',
      },
    ],
  },
},

  ar: {
  'usd-egp': {
    lead:
      'تحويل الدولار الأمريكي (USD) إلى الجنيه المصري (EGP) يعني ضرب المبلغ بالدولار في سعر الصرف اللحظي، والناتج رقم أكبر بكثير بالجنيه. '
      + 'ويجري {{app}} هذا الحساب على هاتفك مجانًا، ويحتفظ بآخر سعر نزّله حين تنقطع الشبكة.',
    h2: 'من يتابع سعر الدولار مقابل الجنيه المصري',
    body: [
      'هذا الزوج هو الرقم الأكثر متابعة في مصر على الإطلاق، ولا يقتصر على من ينوي السفر. منذ الانتقال إلى سعر صرف مرن في مارس 2024 صار الجنيه يتحرك خلال اليوم بدل أن يثبت أسابيع، وصار المعروض في البنوك قريبًا مما كانت تعرضه السوق الموازية قبل ذلك، بعد أن كانت الفجوة بينهما واسعة.',
      'الأثر اليومي أوسع من الحوالات: كثير من السلع المستوردة، وقطع غيار السيارات، وأسعار الوحدات في المدن الجديدة، تُسعَّر بالدولار ثم تُحصَّل بالجنيه، فيقرأ المصري سعر الصرف كأنه مؤشر أسعار لا كأنه رقم للمسافرين. ومصر من أكبر متلقّي التحويلات في العالم، وأكبر مصادرها دول الخليج والولايات المتحدة.',
      'ومن يقارن العروض عليه أن ينتبه إلى أن البنك يعلن سعرين لا سعرًا واحدًا: سعر شراء الدولار منك وسعر بيعه لك، والمسافة بينهما هي ربح البنك من العملية. السعر المرجعي بين البنوك يقع بينهما تقريبًا، ولهذا يصلح كخط أساس تقيس عليه أي عرض.',
    ],
    tips: {
      h3: 'ملاحظات عملية على USD/EGP',
      items: [
        'انظر إلى سعر الشراء المعلن في البنك، لا إلى المتوسط، إذا كنت تبيع دولارات.',
        'الجنيه ينقسم إلى 100 قرش، لكن القروش خرجت عمليًا من التداول اليومي.',
        'تحويلات المصريين في الخارج تتكثّف مع نهاية الشهر ومع مواسم الدراسة والأعياد.',
        'صرافة المطار مريحة لكنها من أوسع الهوامش، فاكتفِ فيها بمبلغ يومك الأول.',
        'ثبّت الزوج في المفضلة داخل {{app}} إذا كنت تتابعه يوميًا.',
      ],
    },
    faq: [
      {
        q: 'لماذا يتغيّر سعر الدولار مقابل الجنيه خلال اليوم الواحد؟',
        a: 'لأن الجنيه المصري لم يعد مثبَّتًا على قيمة معلنة: البنوك تقتبس أسعارها من سوق ما بين البنوك، وهذه السوق تتحرك مع العرض والطلب على الدولار، فتتبدّل الأرقام المعروضة على شاشات الفروع أكثر من مرة في اليوم.',
      },
      {
        q: 'ما الفرق بين سعر الشراء وسعر البيع المعلنين في البنك؟',
        a: 'سعر الشراء هو ما يدفعه البنك لك مقابل دولاراتك، وسعر البيع هو ما تدفعه أنت للحصول على دولار. الفارق بينهما هو هامش البنك، وهو موجود دائمًا حتى حين لا تُذكر أي عمولة صريحة على الإيصال.',
      },
    ],
  },

  'usd-sar': {
    lead:
      'الريال السعودي مربوط بالدولار الأمريكي بسعر ثابت منذ عام 1986، ولهذا يعطي تحويل USD إلى SAR الرقم نفسه تقريبًا كل يوم. '
      + 'السؤال الحقيقي ليس السعر بل الهامش المضاف فوقه.',
    h2: 'لماذا لا يتحرك الدولار أمام الريال السعودي',
    body: [
      'البنك المركزي السعودي — الذي حمل حتى عام 2020 اسم مؤسسة النقد العربي السعودي — يحافظ على هذا الربط منذ منتصف الثمانينات، ويملك من الاحتياطيات ما يجعل الدفاع عنه ممكنًا، كما أن صادرات النفط نفسها مقوَّمة بالدولار، فمدخول الدولة ومرساة عملتها من العملة ذاتها. النتيجة أن مخطط الزوج على خمس سنوات يبدو خطًا مسطحًا، وأن متابعة الأخبار اليومية بحثًا عن «سعر اليوم» لا تضيف شيئًا.',
      'ولأن الرقم ثابت، ينتقل الفرق كله إلى مكان آخر: العمولة. حاجّ أو معتمر يصل بالدولار نقدًا سيجد بين صرافة المطار وصرافة داخل الحي فارقًا حقيقيًا في المبلغ المستلم رغم أن كليهما يقتبس من الربط نفسه. والمقيم الذي يشتري من موقع أمريكي يدفع فوق الربط رسم عملة أجنبية يفرضه مُصدر البطاقة، وهو ما يجعل عمليتين بالمبلغ نفسه تكلّفان بالريال مبلغين مختلفين.',
      'الريال يقسَّم إلى 100 هللة، والدولار إلى 100 سنت، فالخانتان العشريتان متطابقتان ولا يضيع شيء في التقريب بين الطرفين.',
    ],
    tips: {
      h3: 'ملاحظات عملية على USD/SAR',
      items: [
        'الربط ثابت، فالفارق بين مكتب صرافة وآخر هو الهامش وحده لا السعر.',
        'اسأل عن المبلغ المستلم بالريال قبل تسليم النقد، لا عن «السعر» فقط.',
        'عند الشراء من موقع أمريكي اختر الدفع بالدولار ودع بنكك يحوّل، لا الموقع.',
        'رسم العملة الأجنبية على البطاقة يُضاف فوق الربط ولا يظهر في أي سعر معلن.',
        'مخطط الخمس سنوات في {{app}} يوضّح كم هو مستقرّ هذا الزوج فعليًا.',
      ],
    },
    faq: [
      {
        q: 'هل يتغيّر سعر الدولار مقابل الريال السعودي أصلًا؟',
        a: 'عمليًا لا. الربط بالدولار قائم بسعر ثابت منذ عام 1986، وما يظهر من تذبذب طفيف في السوق الفورية يبقى داخل نطاق ضيق جدًا حول هذه القيمة، ولا يقارَن بحركة العملات العائمة.',
      },
      {
        q: 'لماذا يختلف المبلغ الذي أستلمه بين صرافة وأخرى رغم ثبات الربط؟',
        a: 'لأن الربط يحدد السعر الرسمي فقط، بينما يحدد كل مكتب صرافة هامشه فوقه بحرية. المطارات والفنادق تعمل بهوامش أوسع لأن زبونها مضطر، ومقارنة المبلغ المستلم هي الطريقة الوحيدة لكشف الفارق.',
      },
    ],
  },

  'usd-aed': {
    lead:
      'الدرهم الإماراتي مثبَّت بسعر ثابت مقابل الدولار الأمريكي منذ عام 1997، فتحويل USD إلى AED يعطي عمليًا الرقم نفسه في كل مرة تحسبه فيها. '
      + 'ما يتبدّل هو هامش الجهة التي تصرف لك.',
    h2: 'الدرهم الإماراتي والدولار: ربط قديم وهوامش متفاوتة',
    body: [
      'التثبيت عند هذه القيمة جعل الإمارات مركزًا مريحًا لإعادة التصدير والتجارة: التاجر الذي يشتري بالدولار ويبيع بالدرهم لا يحمل مخاطرة عملة بين الصفقتين، ولهذا تُحرَّر كثير من فواتير المناطق الحرة بالدولار مباشرة بينما تُدفع مصاريف التشغيل المحلية بالدرهم. كثير من الباعة يقرّبون السعر ذهنيًا عند الحساب السريع، والفارق يظهر فقط في المبالغ الكبيرة.',
      'أما الزائر فيلتقي بالمشكلة في مكان مختلف تمامًا: جهاز الدفع في المول أو في الفندق يعرض عليه أن يُحاسَب بعملة بلده بدل الدرهم. هذا العرض تحويل عملة عند نقطة البيع، وسعره يضعه المشغّل لا البنك المركزي، وهو غالبًا أبعد ما يكون عن الربط. رفض العرض والدفع بالدرهم يترك التحويل لمُصدر البطاقة، وهو أقرب إلى السعر المرجعي.',
      'الأسعار المعروضة للمستهلك في الإمارات تشمل ضريبة القيمة المضافة بنسبة 5% المطبَّقة منذ 2018، فالمبلغ الذي تراه على الرفّ هو المبلغ الذي سيُخصم، ولا حاجة لإضافة شيء بعد التحويل.',
    ],
    tips: {
      h3: 'ملاحظات عملية على USD/AED',
      items: [
        'ارفض عرض جهاز الدفع بأن يحاسبك بعملتك، واختر الدرهم دائمًا.',
        'أسعار المتاجر معروضة شاملة ضريبة القيمة المضافة، فالرقم على الرفّ نهائي.',
        'التقريب كافٍ للحساب الذهني، لا للفواتير الكبيرة.',
        'سوق الذهب يسعّر بالدرهم للغرام، فالتحويل يخص وزنك لا القطعة.',
        'احفظ السعر في {{app}} قبل رحلة صحراوية تنقطع فيها التغطية.',
      ],
    },
    faq: [
      {
        q: 'هل الدرهم الإماراتي مربوط بالدولار فعلًا؟',
        a: 'نعم. الدرهم مثبَّت بسعر ثابت مقابل الدولار الأمريكي منذ عام 1997، وهو ربط ثابت لا نطاق تحرّك واسعًا فيه. لهذا يبدو مخطط الزوج خطًا أفقيًا مهما مددت المدى الزمني.',
      },
      {
        q: 'لماذا يعرض عليّ جهاز الدفع في دبي مبلغًا بعملة بلدي؟',
        a: 'هذا تحويل عملة يجريه مشغّل نقطة البيع لا بنكك، ويحمل هامشه الخاص. اختيار الدفع بالدرهم يترك عملية التحويل لمُصدر بطاقتك، وهي عادة أقرب إلى السعر المرجعي من عرض الجهاز.',
      },
    ],
  },

  'sar-egp': {
    lead:
      'الريال السعودي مربوط بالدولار، فحركة زوج SAR/EGP كلها آتية من جانب الجنيه المصري وحده. '
      + 'وتثبيت الزوج في مفضلة {{app}} يضع الرقم أمامك مع نزول الراتب كل شهر.',
    h2: 'ممر الحوالات من المملكة إلى مصر',
    body: [
      'السعودية من أكبر مصادر التحويلات إلى مصر، والجالية المصرية فيها من أقدم الجاليات وأكبرها: مهندسون وأطباء ومعلّمون وفنيون وسائقون، أغلبهم يرسل مبلغًا شهريًا ثابتًا تقريبًا مع نزول الراتب. هذا الإيقاع الشهري هو ما يجعل الزوج مفيدًا: التحويلة تتكرر، فأي تحسّن صغير في السعر يتراكم على مدار السنة.',
      'ولأن الريال مثبَّت أمام الدولار، فإن متابعة سعر الدولار مقابل الجنيه تكفي لتوقّع اتجاه الريال مقابل الجنيه. من يفهم هذه النقطة يتوقف عن انتظار «تحرّك الريال»، لأنه لا يتحرك، ويركّز على الطرف المصري وعلى ما تعرضه شركات الصرافة والتحويل في المملكة.',
      'وتلك الشركات لا تعرض سعرًا واحدًا: السعر يختلف بين التحويل الفوري والتحويل الذي يصل في يوم عمل تالٍ، ويختلف بين الإيداع في حساب بنكي وبين الاستلام النقدي في فرع بمصر. الرسم غالبًا ثابت لكل عملية، فتقسيم مبلغ واحد على عدة حوالات يضاعف الرسوم بلا فائدة.',
    ],
    tips: {
      h3: 'ملاحظات عملية على SAR/EGP',
      items: [
        'تابع الدولار مقابل الجنيه لتعرف إلى أين يتجه الريال مقابل الجنيه.',
        'الرسم ثابت لكل عملية غالبًا، فحوالة واحدة كبيرة أوفر من عدة حوالات صغيرة.',
        'قارن سعر التحويل الفوري بسعر تحويل اليوم التالي قبل التأكيد.',
        'الإيداع البنكي والاستلام النقدي قد يحملان سعرين مختلفين من الشركة نفسها.',
        'نهاية الأسبوع تُقتبس من سعر قديم لأن سوق ما بين البنوك مغلقة.',
      ],
    },
    faq: [
      {
        q: 'لماذا يتحرك سعر الريال مقابل الجنيه إذا كان الريال مربوطًا بالدولار؟',
        a: 'لأن الربط يخصّ طرفًا واحدًا فقط. الريال ثابت أمام الدولار، لكن الجنيه المصري يتحرك بحرية أمام الدولار، وهذه الحركة تنتقل كاملة إلى الزوج، فتبدو وكأنها حركة في الريال بينما مصدرها الجنيه.',
      },
      {
        q: 'هل تختلف أسعار التحويل بين شركات الصرافة في السعودية؟',
        a: 'نعم، وبفارق ملموس على المبالغ الشهرية المتكررة. لكل شركة هامشها فوق السعر المرجعي، ولكل قناة إرسال تسعير مختلف، والمقارنة الصحيحة تكون على المبلغ الذي يصل بالجنيه بعد كل الرسوم.',
      },
    ],
  },

  'aed-inr': {
    lead:
      'تحويل الدرهم الإماراتي (AED) إلى الروبية الهندية (INR) يعطي رقمًا أكبر بكثير، وحركته كلها من جانب الروبية لأن الدرهم مثبَّت أمام الدولار. '
      + 'ويعطيك {{app}} سعرًا مرجعيًا محايدًا تقيس عليه ما يعرضه محل الصرافة قبل أن ترسل.',
    h2: 'من أكبر ممرات الحوالات في العالم: الإمارات إلى الهند',
    body: [
      'الممر بين الإمارات والهند من أضخم ممرات التحويل الثنائية على مستوى العالم، وتقف خلفه أكبر جالية وافدة في البلاد: هنود يعملون في الإنشاء والضيافة والتجزئة والقطاع الصحي والخدمات المهنية. محلات الصرافة في ديرة والكرامة تعلّق لوحات إلكترونية تتغيّر أرقامها خلال اليوم، وطوابيرها تطول في اليومين الأولين من كل شهر مع نزول الرواتب.',
      'العادة السائدة هي الانتظار: يراقب المحوِّل الرقم أيامًا ثم يرسل دفعة واحدة كبيرة حين يبدو مناسبًا. المنطق سليم ما دام المرء يراقب الرقم الصحيح، فالسعر المعلّق على لوحة المحل يتضمن هامش المحل أصلًا، والسعر المرجعي وحده يصلح خط أساس تقيس عليه العروض.',
      'ونقطة تربك من لم يتعامل مع الأرقام الهندية: المبالغ تُكتب بـ«لاك» ويساوي مئة ألف، وبـ«كرور» ويساوي عشرة ملايين، مع فواصل توضع بطريقة مختلفة عن المعتاد. تحويل الدرهم إلى روبية يصل بك إلى الرقم، لكن قراءة الرقم بعد ذلك تحتاج هذه القاعدة.',
    ],
    tips: {
      h3: 'ملاحظات عملية على AED/INR',
      items: [
        '«لاك» تساوي مئة ألف روبية و«كرور» تساوي عشرة ملايين روبية.',
        'الدرهم مثبَّت أمام الدولار، فأي تحرّك في الزوج مصدره الروبية.',
        'الرسوم الثابتة تجعل التحويلة الكبيرة أرخص نسبيًا لكل درهم مرسَل.',
        'الأسعار المعلّقة في محلات الصرافة تشمل الهامش قبل أن تراها.',
        'مواسم الأعياد الهندية ترفع الطلب على التحويل وتضغط على الهوامش.',
      ],
    },
    faq: [
      {
        q: 'ما معنى لاك وكرور في المبالغ الهندية؟',
        a: 'اللاك مئة ألف روبية والكرور عشرة ملايين روبية. هما طريقة في كتابة الأرقام لا وحدتان مستقلتان، فحوّل قيمة الروبية نفسها داخل {{app}} لتعرف مقابلها بالدرهم الإماراتي.',
      },
      {
        q: 'هل أرسل الآن أم أنتظر تحسّن سعر الدرهم مقابل الروبية؟',
        a: 'الدرهم لن يتحرك لأنه مثبَّت، فالانتظار يعني في الحقيقة انتظار تحرّك الروبية. قارن عرض شركة التحويل بالسعر المرجعي في {{app}}: إذا كان الهامش واسعًا فتغيير الشركة يفيدك أكثر من انتظار أيام.',
      },
    ],
  },

  'aed-egp': {
    lead:
      'زوج AED/EGP يتحرك من جانب الجنيه المصري فقط، لأن الدرهم الإماراتي مثبَّت أمام الدولار الأمريكي منذ عام 1997. '
      + 'ومعنى ذلك أن أي مفاجأة في قسط عقار مسعَّر بالدولار مصدرها الجنيه لا الدرهم.',
    h2: 'من الإمارات إلى مصر: التحويل والعقار والدراسة',
    body: [
      'الجالية المصرية في الإمارات كبيرة ومتنوعة، وتتوزع بين دبي وأبوظبي والشارقة، وفيها نسبة عالية من أصحاب المهن المكتبية والوظائف التقنية. لهذا يختلف نمط التحويل عن ممرات العمالة التقليدية: مبالغ أقل تكرارًا وأكبر حجمًا، وكثير منها موجّه إلى غرض محدد لا إلى مصروف شهري.',
      'الغرض الأشهر هو العقار. مطوّرون كثيرون في العاصمة الإدارية والساحل الشمالي يسعّرون وحداتهم بالدولار أو يربطون أقساطها به، فيجد المشتري نفسه أمام حسبة من خطوتين: من الدرهم إلى الدولار، ثم من الدولار إلى الجنيه عند سداد القسط. ولأن الطرف الأول مثبَّت، فإن كل مفاجأة في القسط مصدرها الجنيه.',
      'ويضاف إلى ذلك مصاريف الدراسة في الجامعات المصرية، وتذاكر السفر في الإجازات، وتحويلات الاستثمار في شهادات بالجنيه. وفي الاتجاه المعاكس هناك المصري الذي يزور دبي فيحتاج قراءة الرقم مقلوبًا: كم درهمًا يساوي مبلغه بالجنيه قبل أن يحجز.',
    ],
    tips: {
      h3: 'ملاحظات عملية على AED/EGP',
      items: [
        'أقساط العقار المربوطة بالدولار تتبدّل بالجنيه حتى لو لم يتحرك الدرهم.',
        'التحويلات إلى مصر ترتفع مع الأعياد ومع بداية العام الدراسي.',
        'تحويل مبلغ كبير دفعة واحدة يخفض نصيب الرسم الثابت من كل درهم.',
        'الجنيه والدرهم كلاهما بخانتين عشريتين، فلا فقد في التقريب.',
        'بدّل العملتين داخل {{app}} لقراءة الاتجاه الآخر بلمسة واحدة.',
      ],
    },
    faq: [
      {
        q: 'هل يمر تحويل الدرهم إلى الجنيه عبر الدولار؟',
        a: 'حسابيًا نعم في الغالب. الدرهم مثبَّت أمام الدولار والجنيه يُسعَّر أمام الدولار، فتُحسب النتيجة كسعر متقاطع عبر الدولار. لهذا تتبع حركة الزوج تحرّك الجنيه أمام الدولار تتبّعًا شبه كامل.',
      },
      {
        q: 'لماذا يختلف سعر الحوالة عن السعر المرجعي؟',
        a: 'لأن شركة التحويل تضيف هامشها فوق السعر المرجعي، وقد تضيف رسمًا ثابتًا للعملية. الفارق بين الرقمين مضافًا إليه الرسم هو الكلفة الحقيقية للحوالة، وهي غالبًا أكبر مما يوحي به الرسم المعلن وحده.',
      },
    ],
  },

  'sar-inr': {
    lead:
      'تحويل الريال السعودي (SAR) إلى الروبية الهندية (INR) يضاعف الرقم كثيرًا، وتحرّكه اليومي مصدره الروبية لأن الريال مربوط بالدولار منذ 1986. '
      + 'ويحفظ {{app}} آخر سعر نزّله على الجهاز، فتبقى حسبة الحوالة الشهرية ممكنة ولو غاب الاتصال.',
    h2: 'الهنود في المملكة وحوالاتهم الشهرية',
    body: [
      'الجالية الهندية من أكبر الجاليات الوافدة في السعودية، وتتركز في الإنشاء والصيانة والنقل والقطاع الصحي والتجزئة، وأكبر مجموعاتها قادمة من كيرالا وتاميل نادو وأندرا براديش وأوتار براديش. التحويل هنا عادة شهرية منضبطة أكثر منه قرارًا ماليًا: يصل الراتب، فتُرسَل الحصة المخصصة للأسرة في اليوم نفسه أو في اليوم التالي.',
      'شبكة الإرسال في المملكة واسعة: أذرع التحويل التابعة للبنوك، ومحلات الصرافة في الأحياء، والتطبيقات الرقمية التي دخلت بقوة في السنوات الأخيرة. القنوات الرقمية غالبًا أقل رسمًا وأضيق هامشًا من الفرع، لأن كلفة تشغيلها أقل، والفارق يظهر بوضوح على تحويلة تتكرر اثنتي عشرة مرة في السنة.',
      'وتفصيلة تخص الأرقام: الريال يقسَّم إلى مئة هللة، والروبية إلى مئة بيسة، لكن البيسة اختفت عمليًا من التداول اليومي في الهند، فالمبالغ المستلمة تُقرأ صحيحة بلا كسور تقريبًا رغم أن الرمز الدولي يسمح بخانتين عشريتين.',
    ],
    tips: {
      h3: 'ملاحظات عملية على SAR/INR',
      items: [
        'القنوات الرقمية عادة أرخص من الفرع في الرسم وفي الهامش معًا.',
        'الريال ثابت أمام الدولار، فراقب الروبية لا الريال.',
        'الريال مئة هللة والروبية مئة بيسة خرجت فعليًا من التداول.',
        'اسأل عن المبلغ الواصل بالروبية، فهو المقياس الوحيد للمقارنة.',
        'ثبّت الزوج في المفضلة داخل {{app}} ليظهر أول ما تفتحه.',
      ],
    },
    faq: [
      {
        q: 'لماذا يتغيّر سعر الريال مقابل الروبية يوميًا رغم ربط الريال بالدولار؟',
        a: 'لأن الروبية الهندية عملة تتحرك بحرية نسبية أمام الدولار، والريال مثبَّت. الزوج يجمع طرفًا ثابتًا وطرفًا متحركًا، فكل التغيّر الذي تراه على الشاشة مصدره الجانب الهندي وحده.',
      },
      {
        q: 'هل التحويل عبر التطبيقات أرخص من الفرع؟',
        a: 'في الغالب نعم، لأن الرسم أقل والهامش أضيق. لكن القاعدة ليست مطلقة: بعض العروض الترويجية في الفروع تنافس رقميًا لفترة محدودة. قارن المبلغ الواصل بالروبية في القناتين قبل الاختيار.',
      },
    ],
  },

  'usd-mad': {
    lead:
      'الدرهم المغربي ليس عائمًا: بنك المغرب يديره داخل نطاق تذبذب أمام سلة تضم اليورو والدولار، فيتحرك USD/MAD في مدى محدود لا في مدى حر. '
      + 'وما يحرّكه فعلًا ليس المغرب، بل ما يجري بين اليورو والدولار في السوق العالمية.',
    h2: 'الدولار والدرهم المغربي: سلة لا سعر حر',
    body: [
      'السلة التي يُدار الدرهم أمامها يغلب عليها اليورو ويأتي الدولار في المرتبة الثانية، ونطاق التذبذب المسموح به وُسّع تدريجيًا في السنوات الأخيرة ضمن إصلاح معلن للانتقال نحو مرونة أكبر. النتيجة العملية غريبة على من لا يعرف الترتيب: سعر الدولار مقابل الدرهم يتحرك أكثر مما يتحرك اليورو مقابل الدرهم، وسبب حركته الأساسي هو ما يجري بين اليورو والدولار في السوق العالمية.',
      'يهم هذا الزوج المسافر الأمريكي إلى مراكش وفاس والصويرة، ويهم العاملين عن بُعد الذين يقبضون بالدولار ويعيشون بالدرهم، ويهم المستوردين الذين تُحرَّر فواتيرهم بالدولار.',
      'ونقطة يجهلها كثير من الزوار: الدرهم المغربي ليس قابلًا للتحويل بحرية خارج المغرب، فلا تكاد تجده في مكاتب الصرف الأجنبية، والصرف يتم عمليًا بعد الوصول. ولمن يريد إعادة تحويل ما تبقى معه عند المغادرة، الاحتفاظ بإيصالات الصرف هو ما يجعل العملية ممكنة في مكاتب المطار.',
    ],
    tips: {
      h3: 'ملاحظات عملية على USD/MAD',
      items: [
        'الدرهم غير قابل للتحويل بحرية خارج المغرب، فالصرف يتم بعد الوصول.',
        'احتفظ بإيصالات الصرف لتتمكن من إعادة تحويل الباقي عند المغادرة.',
        'حركة اليورو أمام الدولار تنعكس مباشرة على سعر الدولار مقابل الدرهم.',
        'الدرهم يُقسم إلى 100 سنتيم، والخانتان العشريتان مطابقتان للدولار.',
        'مكاتب الصرف المعتمدة تعلن سعرين، للشراء وللبيع، وليس سعرًا واحدًا.',
      ],
    },
    faq: [
      {
        q: 'لماذا يتحرك الدرهم المغربي أمام الدولار أكثر مما يتحرك أمام اليورو؟',
        a: 'لأن اليورو يحمل الوزن الأكبر في السلة التي يُدار الدرهم أمامها، فيبقى قريبًا منه. الدولار وزنه أقل، ولهذا ينتقل جزء من تقلّب اليورو مقابل الدولار إلى سعر الدولار مقابل الدرهم.',
      },
      {
        q: 'هل يمكنني شراء دراهم مغربية قبل السفر؟',
        a: 'ليس بسهولة. الدرهم عملة غير قابلة للتحويل بحرية خارج المغرب، ونادرًا ما تعرضه مكاتب الصرف في الخارج، وإن عرضته فبهامش واسع. الصرف داخل المغرب أو السحب من صراف آلي محلي أقرب إلى السعر المرجعي.',
      },
    ],
  },

  'eur-mad': {
    lead:
      'اليورو صاحب الوزن الأكبر في السلة التي يُدار بها الدرهم المغربي، ولهذا يبقى سعر EUR/MAD أهدأ من سعر الدولار مقابل الدرهم. '
      + 'ومع هذا الهدوء يبقى هامش مكتب الصرف أثقل في كلفتك من حركة السعر نفسها.',
    h2: 'ممر مغاربة العالم: من أوروبا إلى المغرب',
    body: [
      'تحويلات المغاربة المقيمين في الخارج من أهم موارد العملة الصعبة في البلاد، ومصدرها الأكبر فرنسا ثم إسبانيا وإيطاليا وبلجيكا وهولندا. لهذا يُقرأ هذا الزوج في المغرب قراءة موسمية: تتضخم التحويلات في الصيف مع عملية عبور الجالية، وفي رمضان والعيدين، وتهدأ بين ذلك.',
      'العائد في الصيف يأتي غالبًا ومعه نقد باليورو، وهنا تبدأ الفروق. مكاتب الصرف المعتمدة والأبناك تعلن سعر شراء وسعر بيع، والمسافة بينهما ربحها. أما قبول اليورو نقدًا عند تاجر في المدن الشمالية أو في المناطق السياحية فيتم بسعر يضعه التاجر بنفسه، وهو دائمًا أبعد عن السعر المرجعي مما يبدو في لحظة الاستعجال.',
      'ولأن اليورو يهيمن على السلة، فإن الزوج يتحرك في مدى ضيق نسبيًا مقارنة بأزواج عملات عائمة تمامًا. هذا لا يعني أن الكلفة صغيرة: الهامش المضاف على تحويلة متكررة كل شهر يتراكم أكثر مما يتراكم أثر التذبذب نفسه.',
    ],
    tips: {
      h3: 'ملاحظات عملية على EUR/MAD',
      items: [
        'وزن اليورو الكبير في السلة يجعل هذا الزوج أقل تقلّبًا من الدولار مقابل الدرهم.',
        'التحويلات تبلغ ذروتها في الصيف وفي مواسم الأعياد.',
        'الدفع باليورو نقدًا لدى تاجر يتم بسعر يحدده هو، لا بسعر السوق.',
        'مكاتب الصرف المعتمدة تعلن سعر شراء وسعر بيع مختلفين، فاسأل عن المناسب لحالتك.',
        'قارن كلفة الحوالة البنكية بكلفة شركات التحويل على المبلغ نفسه.',
      ],
    },
    faq: [
      {
        q: 'أين أصرف اليورو في المغرب: المطار أم المدينة؟',
        a: 'مكاتب المطار عملية لكنها تعمل بهوامش أوسع. صرف مبلغ صغير يكفي لليوم الأول ثم إكمال الباقي في مكتب معتمد داخل المدينة أو عبر سحب من صراف آلي يقرّبك عادة من السعر المرجعي.',
      },
      {
        q: 'لماذا يتغيّر سعر اليورو مقابل الدرهم قليلًا فقط؟',
        a: 'لأن الدرهم يُدار داخل نطاق أمام سلة يهيمن عليها اليورو، فلا يبتعد عنه كثيرًا. الحركة موجودة لكنها محدودة، وأثر هامش الجهة التي تصرف لك عادة أكبر من أثر هذه الحركة.',
      },
    ],
  },

  'usd-dzd': {
    lead:
      'السعر المرجعي لتحويل الدولار الأمريكي إلى الدينار الجزائري هو السعر الرسمي الذي يعلنه بنك الجزائر، وليس سعر السوق الموازية. '
      + 'وبهذا السعر الرسمي يحسب {{app}}، فاعرف أيّ رقم بين يديك قبل أن تقارن أي عرض.',
    h2: 'الدينار الجزائري: سعر رسمي وسوق موازية وحساب بالسنتيم',
    body: [
      'في الجزائر رقمان متداولان لا رقم واحد. الأول هو السعر الرسمي الذي يعلنه بنك الجزائر وتعمل به البنوك والجمارك وحساب الفواتير، وهو المقصود دائمًا بعبارة «السعر الرسمي». والثاني هو سعر السوق الموازية الذي يتداوله الناس في العاصمة وغيرها، ويكون أبعد من السعر الرسمي. المسافة بين الرقمين ليست خطأ في أحدهما، بل نتيجة قيود الصرف والطلب على العملة الصعبة لأغراض السفر والاستيراد.',
      'والدينار غير قابل للتحويل خارج البلاد، فلا يمكن شراؤه أو بيعه في مكاتب الصرف الأجنبية، ومنحة السفر التي يحصل عليها المسافر من بنكه محدودة. لهذا تعتمد الجالية في فرنسا وكندا على إرسال العملة الصعبة نفسها.',
      'ويبقى فخّ الأرقام: الجزائريون يسعّرون كثيرًا بالسنتيم لا بالدينار. حين يقول أحدهم إن سعر شيء «مليون» فهو يقصد مليون سنتيم، أي عشرة آلاف دينار، وحين يقول «ألف» فهو يقصد ألف سنتيم أي عشرة دنانير. حوّل إلى الدينار أولًا ثم أدخل الرقم في {{app}}.',
    ],
    tips: {
      h3: 'ملاحظات عملية على USD/DZD',
      items: [
        '«مليون» في الحديث اليومي تعني مليون سنتيم، أي عشرة آلاف دينار.',
        'السعر المرجعي هو السعر الرسمي، لا سعر السوق الموازية.',
        'الدينار غير قابل للتحويل خارج الجزائر، فلا تحمل منه عند المغادرة.',
        'الدينار يُقسم إلى 100 سنتيم رسميًا رغم غياب القطع الصغيرة عن التداول.',
        'يحفظ {{app}} آخر سعر رسمي على الجهاز فيعمل بلا اتصال.',
      ],
    },
    faq: [
      {
        q: 'ماذا تعني «مليون» في تسعير الجزائريين؟',
        a: 'تعني مليون سنتيم أي عشرة آلاف دينار جزائري. عادة التسعير بالسنتيم منتشرة في السيارات والعقار والرواتب، وهي أكثر ما يربك غير المعتاد عليها، لأن الرقم المنطوق أكبر من الرقم الرسمي مئة مرة.',
      },
      {
        q: 'لماذا يختلف السعر الرسمي عن سعر السوق الموازية؟',
        a: 'لأن الحصول على العملة الصعبة بالسعر الرسمي محكوم بقيود وبحصص محددة، بينما يعكس السوق الموازية الطلب الحر عليها. ويعمل {{app}} بالسعر الرسمي المرجعي، وهو الأساس المعتمد في البنوك والمعاملات النظامية.',
      },
    ],
  },

  'eur-tnd': {
    lead:
      'الدينار التونسي يُكتب بثلاث خانات عشرية لأنه ينقسم إلى ألف مليم، فناتج تحويل EUR إلى TND يظهر بثلاث منازل بعد الفاصلة. '
      + 'ولهذا يقرأ القادم من منطقة اليورو الأسعار التونسية غلطًا في أول يوم له.',
    h2: 'اليورو والدينار التونسي: ثلاث منازل وقيود صرف',
    body: [
      'أول ما يلفت الزائر أن الأسعار في تونس مكتوبة بثلاث منازل عشرية، لأن الدينار ألف مليم لا مئة وحدة فرعية. القارئ الذي يتعامل مع اليورو أو الدولار يقرأ الرقم غلطًا في البداية، ويظنّ المنزلة الثالثة خطأً مطبعيًا. اضبط عدد الخانات العشرية على ثلاث حين تحسب بالدينار، وإلا فقدت جزءًا من المبلغ في التقريب.',
      'الجمهور الأساسي لهذا الزوج جمهوران: السياح القادمون من فرنسا وإيطاليا وألمانيا إلى الحمامات وجربة وسوسة، والجالية التونسية في أوروبا التي ترسل إلى أهلها وتقضي الصيف في البلاد. ولذلك يُقرأ السعر مرتين في السنة قراءة كثيفة: قبل موسم الصيف وعند إعداد ميزانية العطلة.',
      'والقاعدة التي تفاجئ كثيرين: الدينار التونسي عملة غير قابلة للتحويل، وإخراجه من البلاد ممنوع، ولا تكاد تجده معروضًا في مكاتب الصرف الأوروبية. الصرف يتم بعد الوصول، والاحتفاظ بإيصالات الصرف هو ما يسمح بإعادة تحويل ما تبقّى إلى اليورو قبل المغادرة.',
    ],
    tips: {
      h3: 'ملاحظات عملية على EUR/TND',
      items: [
        'الدينار التونسي ألف مليم، فالأسعار تُكتب بثلاث منازل عشرية.',
        'إخراج الدينار من تونس ممنوع، فأعد تحويل ما تبقّى قبل المغادرة.',
        'احتفظ بإيصالات الصرف، فهي شرط إعادة التحويل في مكاتب المطار.',
        'كثير من المنشآت السياحية تعرض أسعارًا باليورو لكن الدفع يتم بالدينار.',
        'اضبط عدد الخانات العشرية على ثلاث داخل {{app}} قبل الحساب.',
      ],
    },
    faq: [
      {
        q: 'لماذا للدينار التونسي ثلاث خانات عشرية؟',
        a: 'لأن الدينار التونسي مقسوم إلى ألف مليم، لا إلى مئة وحدة فرعية كاليورو أو الدولار. الرمز الدولي ISO 4217 يعطيه الأُسّ ثلاثة، ولهذا تُكتب الأسعار وتُحسب الفواتير بثلاث منازل بعد الفاصلة.',
      },
      {
        q: 'هل يمكنني إخراج الدينار التونسي معي عند السفر؟',
        a: 'لا. الدينار عملة غير قابلة للتحويل وإخراجها من البلاد غير مسموح به. أعد تحويل ما تبقّى معك إلى اليورو قبل المغادرة، مصطحبًا إيصالات الصرف التي حصلت عليها عند التحويل الأول.',
      },
    ],
  },

  'usd-kwd': {
    lead:
      'الدينار الكويتي أعلى وحدة عملة قيمةً في العالم ويُكتب بثلاث خانات عشرية، فتحويل USD إلى KWD يعطي رقمًا أصغر من المبلغ الذي بدأت به. '
      + 'ويحسب {{app}} الزوج بمنازله الثلاث كاملة، فلا يضيع الفلس في التقريب.',
    h2: 'الدينار الكويتي: سلة عملات وثلاث منازل عشرية',
    body: [
      'الكويت لا تربط دينارها بالدولار وحده كما تفعل السعودية والإمارات، بل بسلة مرجّحة من عملات لا يُعلن تركيبها، وذلك منذ عام 2007. الأثر واضح على المخطط: الزوج شبه ثابت لكنه ليس خطًا مسطحًا تمامًا، إذ ينزلق قليلًا حين تتحرك العملات الأخرى داخل السلة أمام الدولار. من اعتاد ثبات الريال أو الدرهم يلاحظ هذا الفارق الصغير.',
      'وأشهر خطأ في هذا الزوج ليس في السعر بل في الفاصلة. الدينار ألف فلس، فالأسعار تُكتب بثلاث منازل عشرية، وقراءة منزلة واحدة غلطًا تعني خطأً بعشرة أضعاف. وحين تكون وحدة العملة بهذه القيمة العالية، فإن خطأ الخانة الواحدة يساوي مبلغًا حقيقيًا لا تفصيلًا شكليًا.',
      'أما الاستخدام اليومي فيأتي من الوافدين: الكويت من أعلى دول المنطقة نسبةً في العمالة الوافدة، والتحويل الشهري إلى الهند ومصر والفلبين وبنغلاديش وباكستان جزء ثابت من الرواتب، ويُحسب أولًا من الدينار إلى الدولار ثم إلى عملة البلد.',
    ],
    tips: {
      h3: 'ملاحظات عملية على USD/KWD',
      items: [
        'الدينار الكويتي ألف فلس، فاقرأ ثلاث منازل عشرية لا منزلتين.',
        'خطأ منزلة عشرية واحدة يعني عشرة أضعاف المبلغ الصحيح.',
        'الربط بسلة عملات لا بالدولار وحده، فالسعر ينزلق قليلًا بدل أن يتجمد.',
        'اضبط عدد الخانات العشرية على ثلاث داخل {{app}} قبل أي حساب.',
        'الحوالات إلى آسيا تُحسب عمليًا عبر الدولار كعملة وسيطة.',
      ],
    },
    faq: [
      {
        q: 'لماذا يتحرك الدينار الكويتي قليلًا رغم ارتباطه بالدولار؟',
        a: 'لأنه ليس مربوطًا بالدولار وحده. الكويت تربط دينارها منذ عام 2007 بسلة مرجّحة من عملات لا يُعلن تركيبها، فحين تتحرك تلك العملات أمام الدولار ينتقل جزء صغير من الحركة إلى سعر الدولار مقابل الدينار.',
      },
      {
        q: 'كم فلسًا في الدينار الكويتي؟',
        a: 'ألف فلس. لهذا يعطي الرمز الدولي ISO 4217 للدينار الكويتي الأُسّ ثلاثة، وتُكتب أسعاره وفواتيره بثلاث منازل بعد الفاصلة، خلافًا للدولار والريال والدرهم التي تُكتب بمنزلتين.',
      },
    ],
  },
},

  vi: {
  'usd-vnd': {
    lead:
      'Đổi đô la Mỹ (USD) sang đồng Việt Nam (VND) luôn cho ra một con số rất dài, vì mỗi đô la tương đương hàng chục nghìn đồng và tiền đồng không có đơn vị lẻ. '
      + 'Phép nhân ấy để {{app}} làm, kể cả lúc máy không có mạng; cái khó của cặp này nằm ở ba cột giá trên bảng điện tử của quầy ngân hàng.',
    h2: 'Ai hay tra USD sang VND',
    body: [
      'Đây là cặp tiền được người Việt tra nhiều nhất, và phần lớn không phải vì đầu tư. Đó là kiều hối từ Mỹ gửi về cho gia đình, là học phí du học phải đóng bằng đô, là tiền hàng của dân xuất nhập khẩu, và là câu hỏi quen thuộc mỗi khi ai đó cầm trong tay một tờ một trăm đô.',
      'Thứ khiến cặp này khác hẳn các cặp còn lại là cách tỷ giá được điều hành. Ngân hàng Nhà nước công bố tỷ giá trung tâm vào mỗi ngày làm việc, và các ngân hàng thương mại chỉ được niêm yết trong một biên độ quanh mức đó, nên USD/VND đi theo bậc thang chứ hiếm khi nhảy dựng. Bảng điện tử ở quầy vì thế có tới ba cột: mua tiền mặt, mua chuyển khoản và bán ra — ba con số khác nhau cho cùng một đồng đô.',
      'Khoảng cách giữa tỷ giá tham chiếu trong {{app}} và cột "bán ra" ở quầy chính là phần bạn trả. Riêng với tiền mặt còn thêm một yếu tố nữa: tờ một trăm đô mới, phẳng, không rách thường được mua vào cao hơn tờ mệnh giá nhỏ hay tờ đã sờn mép.',
    ],
    tips: {
      h3: 'Thực tế khi đổi đô ở quầy',
      items: [
        'Trên lãnh thổ Việt Nam, mọi giao dịch mua bán phải thanh toán bằng tiền đồng, nên báo giá bằng đô ở cửa hàng chỉ là cách quy chiếu.',
        'Chỉ đổi ở ngân hàng hoặc điểm thu đổi được cấp phép; tờ hoá đơn đổi tiền là thứ hải quan có quyền hỏi tới.',
        'Giá mua tiền mặt luôn thấp hơn giá mua chuyển khoản, nên tiền về tài khoản thường lợi hơn tiền cầm tay.',
        'Xem tỷ giá tham chiếu trước rồi mới so với giá quầy — chênh lệch giữa hai con số mới là chi phí thật.',
      ],
    },
    faq: [
      {
        q: 'Vì sao mỗi ngân hàng niêm yết USD/VND một giá khác nhau?',
        a: 'Vì tỷ giá trung tâm chỉ là mức tham chiếu. Trong biên độ được phép, từng ngân hàng tự đặt giá mua và giá bán tuỳ trạng thái ngoại tệ của mình hôm đó, nên chênh lệch giữa các quầy là chuyện bình thường.',
      },
      {
        q: 'Đổi tờ một trăm đô và tờ hai mươi đô có cùng giá không?',
        a: 'Thường là không. Nhiều nơi mua tờ mệnh giá lớn với giá cao hơn tờ nhỏ, còn tờ nhàu, rách hay dính mực thì bị trừ thêm. Đó là chênh lệch của tiền mặt, không phải của tỷ giá.',
      },
    ],
  },

  'krw-vnd': {
    lead:
      'Won Hàn Quốc (KRW) và đồng Việt Nam (VND) đều không có đơn vị lẻ, nên kết quả quy đổi KRW sang VND luôn là số nguyên, không có phần thập phân. '
      + 'Đây là con số hàng trăm nghìn người Việt ở Hàn tra vào mỗi kỳ lương, và {{app}} tra được cả lúc không có mạng.',
    h2: 'Nhịp lương ở Hàn quyết định cặp KRW/VND',
    body: [
      'Hàn Quốc là một trong những nơi tập trung đông người Việt đi làm và đi học nhất ở Đông Bắc Á: công nhân theo chương trình cấp phép việc làm EPS, lao động thời vụ nông nghiệp, du học sinh làm thêm. Với họ, KRW/VND không phải chuyện thị trường mà là chuyện lịch: cuối tháng nhận won, đầu tháng gửi về nhà.',
      'Vì các khoản gửi lặp đi lặp lại và gần bằng nhau, chỉ cần chọn ngày khá hơn một chút thì cả năm cộng lại đã ra khác biệt thấy được. Muốn chọn thì phải biết một mốc độc lập, chứ nhìn mỗi con số bên dịch vụ chuyển tiền đưa ra thì không so được — con số đó đã gói sẵn phần lời của họ.',
      'Chiều ngược lại cũng đông không kém: người mua mỹ phẩm, quần áo và đồ ăn Hàn thẳng từ các trang bán hàng bên đó. Bẫy quen thuộc ở đây là để website tự quy ra tiền đồng ngay lúc thanh toán thay vì trả bằng won.',
    ],
    tips: {
      h3: 'Ghi chú cho người gửi tiền từ Hàn',
      items: [
        'Won không có đơn vị nhỏ hơn, giá ở Hàn vì thế thường có bốn tới năm chữ số; đừng đọc nhầm thành phần lẻ.',
        'Lệnh chuyển tiền cuối tuần hay bị áp mức của phiên thứ Sáu, do thị trường liên ngân hàng đã đóng cửa.',
        'Trên trang bán hàng Hàn Quốc, chọn thanh toán bằng won; để trang tự đổi sang tiền đồng là chấp nhận tỷ giá của họ.',
        'Ghim KRW/VND vào mục yêu thích trong {{app}} nếu tháng nào bạn cũng phải tra.',
      ],
    },
    faq: [
      {
        q: 'Gửi tiền từ Hàn về Việt Nam thì nên nhìn con số nào?',
        a: 'Lấy tỷ giá tham chiếu KRW/VND trong {{app}} làm mốc, rồi so với số tiền đồng mà người nhà thật sự nhận được. Bên chuyển tiền hay quảng cáo phí thấp nhưng bù lại ở tỷ giá, nên chỉ số cuối cùng mới nói lên chi phí.',
      },
      {
        q: 'Vì sao giá ở Hàn Quốc nhìn dài đến vậy?',
        a: 'Won có số mũ ISO 4217 bằng không, tức là không còn đơn vị lẻ nào lưu hành, nên một bữa ăn bình thường cũng viết bằng hàng nghìn won. Tiền đồng cũng vậy, chỉ khác ở độ dài của con số.',
      },
    ],
  },

  'jpy-vnd': {
    lead:
      'Yên Nhật (JPY) cũng không có đơn vị lẻ, nên quy đổi JPY sang đồng Việt Nam (VND) là phép nhân giữa hai số nguyên và cho ra một số nguyên. '
      + 'Đây là cặp tiền của thực tập sinh, kỹ sư và du học sinh tại Nhật; {{app}} tính được ngay cả khi điện thoại ngoại tuyến.',
    h2: 'Vì sao người Việt ở Nhật theo cặp này sát đến thế',
    body: [
      'Cộng đồng người Việt tại Nhật phình ra rất nhanh trong hơn mười năm qua: thực tập sinh kỹ năng, lao động kỹ năng đặc định, kỹ sư và du học sinh làm thêm theo giới hạn giờ được phép. Với nhóm này, JPY/VND xuất hiện vào mỗi kỳ lương và mỗi lần đóng học phí, chứ không phải mỗi khi có tin kinh tế.',
      'Chỗ khó chịu của cặp này là đồng yên đã suy yếu nhiều năm liền so với đô la Mỹ. Cùng một mức lương tính bằng yên, khoản tiền đồng gửi về nhà không còn như trước, và đó là lý do nhiều người theo dõi tỷ giá kỹ hơn hẳn mức cần thiết cho một chuyến du lịch thuần tuý.',
      'Ở chiều du lịch, cái bẫy lại là số chữ số. Một hoá đơn năm chữ số ở Nhật là chuyện thường ngày; đọc nó như thể có hai chữ số lẻ sẽ khiến mọi thứ đắt gấp trăm lần trong đầu bạn.',
    ],
    tips: {
      h3: 'Ghi chú khi tiêu và gửi tiền từ Nhật',
      items: [
        'Giá niêm yết ở Nhật đã gồm thuế tiêu dùng, nên con số trên kệ là con số phải trả.',
        'Nhật vẫn xài nhiều tiền mặt; máy rút tiền trong cửa hàng tiện lợi là nơi thẻ nước ngoài dễ được chấp nhận nhất.',
        'Không còn đồng xu nào nhỏ hơn một yên đang lưu hành, nên kết quả quy đổi luôn tròn.',
        'Nếu tháng nào cũng gửi tiền về, hãy mở biểu đồ dài hạn trong {{app}} để biết mức hiện tại đang nằm ở đâu.',
      ],
    },
    faq: [
      {
        q: 'Vì sao giá ở Nhật không có phần thập phân?',
        a: 'Số mũ ISO 4217 của yên bằng không: đơn vị nhỏ hơn yên đã ngừng lưu hành từ lâu. Vì thế một bữa trưa vài trăm yên hay một đôi giày vài chục nghìn yên đều viết trọn, không có dấu phẩy thập phân.',
      },
      {
        q: 'Thực tập sinh nên gửi tiền về hằng tháng hay dồn lại gửi một lần?',
        a: 'Phí cố định của mỗi lệnh chia cho một khoản lớn hơn thì nhẹ hơn, nên dồn lại thường rẻ hơn. Đổi lại bạn ôm rủi ro tỷ giá lâu hơn, vậy nên hãy so tổng tiền đồng nhận được ở cả hai cách.',
      },
    ],
  },

  'cny-vnd': {
    lead:
      'Quy đổi nhân dân tệ (CNY) sang đồng Việt Nam (VND) cho ra con số hàng nghìn đồng cho mỗi tệ, và đây là cặp tiền của dân buôn hàng Trung Quốc. '
      + 'Cứ để {{app}} tính ra mốc, rồi đem mốc đó ra đối chiếu với mức mà bên đặt hàng hộ báo cho bạn.',
    h2: 'Cặp tiền của biên mậu và hàng đặt hộ',
    body: [
      'CNY/VND sống ở hai nơi rất cụ thể: các cửa khẩu phía Bắc như Lạng Sơn, Móng Cái, Lào Cai, nơi hàng chạy theo đường biên mậu; và màn hình điện thoại của những người đặt hàng trên các sàn bán buôn Trung Quốc.',
      'Với người mua hộ, tỷ giá không phải thứ lấy từ ngân hàng. Mỗi đơn vị nhận đặt hàng tự công bố một mức riêng, thường cao hơn mốc tham chiếu, và đó chính là chỗ họ ăn lời bên cạnh phí dịch vụ, phí cân nặng và phí vận chuyển. Biết mốc tham chiếu trước khi chốt đơn là cách duy nhất để thấy mình đang trả thêm bao nhiêu.',
      'Một chi tiết kỹ thuật hay gây nhầm: đồng tiền tên là nhân dân tệ, đơn vị đếm là nguyên, và tồn tại hai mức giá. CNY là giá trong nước, được Ngân hàng Nhân dân Trung Quốc giữ quanh một mức tham chiếu công bố hằng ngày; CNH là giá ngoài khơi giao dịch ở Hồng Kông. Hai con số thường sát nhau nhưng không bằng nhau.',
    ],
    tips: {
      h3: 'Ghi chú cho người đặt hàng Trung Quốc',
      items: [
        'Người Việt hay gọi tắt là "tệ": một tệ tức là một nhân dân tệ, mã ISO 4217 ghi CNY.',
        'Hỏi thẳng bên đặt hộ đang dùng mức nào và đã cộng bao nhiêu so với giá ngân hàng.',
        'Ở cửa khẩu, quầy tư nhân và ngân hàng cho hai mức khác nhau; ngân hàng có chứng từ, quầy tư nhân thì không.',
        'CNY là giá trong nước còn CNH là giá ngoài khơi — kiểm tra nhà cung cấp đang báo theo loại nào.',
      ],
    },
    faq: [
      {
        q: 'Mức quy đổi mà bên đặt hàng hộ áp có giống ngân hàng không?',
        a: 'Không. Đơn vị nhận đặt hàng tự đặt mức của mình, thường cao hơn mốc tham chiếu vài phần trăm, và đó là một phần lợi nhuận của họ. Hãy tự quy đổi giá gốc trên sàn rồi so với con số họ báo.',
      },
      {
        q: 'Nhân dân tệ và nguyên khác nhau chỗ nào?',
        a: 'Nhân dân tệ là tên của đồng tiền, còn nguyên là đơn vị đếm, giống quan hệ giữa "tiền Việt Nam" và "đồng". Mã dùng để tra tỷ giá là CNY, hoặc CNH nếu là giá ngoài khơi.',
      },
    ],
  },

  'twd-vnd': {
    lead:
      'Quy đổi đô la Đài Loan mới (TWD) sang đồng Việt Nam (VND) là phép tính hằng tháng của hàng trăm nghìn lao động Việt đang làm việc tại Đài Loan. '
      + '{{app}} lo phép tính đó ngay trong xưởng không có sóng, còn phần khó hơn là biết trước quầy ở nhà có mua Đài tệ tiền mặt hay không.',
    h2: 'Đài tệ, đồng lương và tấm vé về nước',
    body: [
      'Xét theo số người đang làm việc, Đài Loan nằm trong nhóm hai thị trường tiếp nhận nhiều lao động Việt Nam nhất: nhà máy, công trường, tàu cá và chăm sóc người già. Cộng thêm du học sinh cùng các gia đình có cô dâu Việt, TWD/VND là con số được tra đều đặn theo kỳ lương chứ không theo tin tức.',
      'Đài tệ có hai chữ số lẻ trên giấy tờ, nhưng đời sống thì không ai đếm phần lẻ: đồng xu gặp trong đời thường nhỏ nhất là loại một Đài tệ, nên giá thực tế gần như luôn tròn. Ký hiệu NT$ lại dùng chung dấu đô la, dễ bị đọc nhầm thành đô Mỹ hay đô Singapore nếu chỉ liếc qua ký hiệu.',
      'Về phía Việt Nam, không phải quầy nào cũng có sẵn Đài tệ tiền mặt, và tờ Đài tệ mang về nước thường bị mua lại kém hơn nhiều so với đường chuyển khoản. Vì thế phần lớn tiền về nhà đi qua ngân hàng hoặc công ty chuyển tiền được cấp phép, chứ không nằm trong vali.',
    ],
    tips: {
      h3: 'Ghi chú cho lao động tại Đài Loan',
      items: [
        'Người Việt bên đó quen gọi TWD là "Đài tệ"; mã ISO 4217 chính thức vẫn viết là TWD.',
        'Đời thường hầu như chỉ tiêu tới đơn vị một Đài tệ, nên hoá đơn gần như không bao giờ có phần lẻ.',
        'So tổng số tiền đồng người nhà nhận được, thay vì so mức phí mà từng nơi quảng cáo.',
        'Trước ngày hết hạn hợp đồng, hỏi trước ngân hàng ở nhà có mua Đài tệ tiền mặt hay không.',
      ],
    },
    faq: [
      {
        q: 'Mang Đài tệ tiền mặt về Việt Nam đổi có lợi không?',
        a: 'Thường là kém lợi. Đài tệ ít được giao dịch tại Việt Nam nên khoảng cách giữa giá mua và giá bán rộng hơn hẳn đô la Mỹ. Chuyển khoản qua kênh chính thức thường về được nhiều tiền đồng hơn.',
      },
      {
        q: 'NT$ có phải là đô la Mỹ không?',
        a: 'Không. NT$ là ký hiệu của đô la Đài Loan mới, mã TWD, do ngân hàng trung ương Đài Loan phát hành. Dấu đô la được rất nhiều đồng tiền dùng chung, nên hãy nhìn mã ISO thay vì nhìn ký hiệu.',
      },
    ],
  },

  'eur-vnd': {
    lead:
      'Euro (EUR) là đồng tiền chung của phần lớn các nước Liên minh châu Âu, nên một lần quy đổi EUR sang đồng Việt Nam (VND) đủ dùng cho cả hành trình nhiều quốc gia. '
      + 'Với điều kiện những nước đó thật sự xài euro — và không ít nước ở châu Âu thì không.',
    h2: 'Đi châu Âu, đổi euro tới đâu là đủ',
    body: [
      'Cặp EUR/VND thuộc về ba nhóm: du học sinh và người lao động ở Đức, Pháp, Hà Lan; cộng đồng người Việt lâu đời tại Đông Âu; và khách đi tour châu Âu, kiểu hành trình mười ngày qua năm nước.',
      'Chính nhóm cuối hay vấp đúng một chỗ. Euro là tiền chung của phần lớn các nước thành viên Liên minh châu Âu, nhưng châu Âu thì rộng hơn khu vực đồng euro rất nhiều: Séc vẫn dùng koruna, Ba Lan dùng złoty, Hungary dùng forint, Thuỵ Sĩ dùng franc, còn Anh dùng bảng. Đổi sẵn một cục euro ở nhà rồi tới Praha lại phải đổi tiếp là chuyện xảy ra liên tục.',
      'Bù lại có một điểm dễ chịu: giá niêm yết trong Liên minh châu Âu đã gồm thuế giá trị gia tăng, nên con số trên nhãn là con số phải trả. Khách từ ngoài khối còn có thể xin hoàn phần thuế đó khi rời châu Âu, thủ tục làm ở sân bay trước lúc ký gửi hành lý.',
    ],
    tips: {
      h3: 'Ghi chú trước khi bay sang châu Âu',
      items: [
        'Tra từng nước trong lịch trình đang dùng đồng tiền gì, trước khi quyết định đổi bao nhiêu ở nhà.',
        'Quầy thu đổi trong sân bay châu Âu gần như luôn kém hơn rút tiền tại máy của một ngân hàng.',
        'Khi máy thanh toán hỏi muốn tính bằng tiền đồng hay bằng euro, hãy chọn euro.',
        'Giữ hoá đơn nếu định hoàn thuế; mức tối thiểu và thủ tục khác nhau theo từng nước.',
      ],
    },
    faq: [
      {
        q: 'Đi tour châu Âu chỉ mang euro là đủ chưa?',
        a: 'Chưa chắc. Khu vực đồng euro không phủ hết châu Âu: nhiều điểm đến quen thuộc như Séc, Ba Lan, Hungary hay Thuỵ Sĩ vẫn giữ đồng tiền riêng. Hãy tra từng chặng, hoặc dùng thẻ và để ngân hàng lo phần quy đổi.',
      },
      {
        q: 'Nên đổi euro ở Việt Nam hay sang tới nơi mới đổi?',
        a: 'Đổi một phần nhỏ ở nhà để có tiền mặt đi lại ngày đầu, phần còn lại rút tại máy của ngân hàng bên đó. Quầy thu đổi ở sân bay và ở khách sạn thường là chỗ cho giá kém nhất.',
      },
    ],
  },

  'thb-vnd': {
    lead:
      'Quy đổi baht Thái (THB) sang đồng Việt Nam (VND) chủ yếu phục vụ những chuyến đi ngắn, vì Bangkok là một trong các chặng bay rẻ và gần nhất từ Việt Nam. '
      + 'Đứng ngay tại quầy mà cần ước lượng nhanh thì mở {{app}}, còn câu hỏi đáng tiền hơn là nên đổi baht ở Việt Nam hay sang tới nơi mới đổi.',
    h2: 'Ba ngày hai đêm và một túi baht',
    body: [
      'THB/VND ít khi là chuyện tiền lương. Đây là cặp của các chuyến đi cuối tuần, của dân buôn hàng Thái — đồ gia dụng, đồ ăn vặt, mỹ phẩm — và của cả người gốc Việt sống lâu năm ở vùng đông bắc Thái Lan.',
      'Vấn đề thực tế nằm ở chỗ tiền đồng không phải ngoại tệ mạnh trên thị trường Thái. Cầm tiền đồng sang Bangkok, các quầy thu đổi mua vào rất thấp, thậm chí nhiều quầy từ chối nhận. Đổi sang baht ngay tại Việt Nam, hoặc dùng thẻ và rút baht tại chỗ, gần như luôn ra kết quả tốt hơn.',
      'Về mặt đơn vị, baht chia thành satang trên giấy tờ nhưng thanh toán đời thường hầu như luôn tròn baht. Giá cũng hay viết ký hiệu đứng trước số, ngược với thói quen của người Việt là đặt chữ đ ở cuối.',
    ],
    tips: {
      h3: 'Ghi chú cho chuyến đi Thái Lan',
      items: [
        'Đừng mang tiền đồng sang Thái để đổi; giá mua vào bên đó rất thấp.',
        'Máy rút tiền ở Thái Lan thu một khoản phí cố định cho mỗi lần rút bằng thẻ nước ngoài, nên rút ít lần với số lớn sẽ đỡ hơn.',
        'Khi máy hỏi có muốn tính bằng tiền đồng không, hãy từ chối và chọn baht.',
        'Chợ và xe ôm bên đó vẫn ưu tiên tiền mặt, dù thanh toán quét mã đã rất phổ biến.',
      ],
    },
    faq: [
      {
        q: 'Nên đổi baht tại Việt Nam hay sang Thái mới đổi?',
        a: 'Đổi ở Việt Nam thường lợi hơn, vì tiền đồng bị các quầy bên đó mua vào rất thấp. Nếu cần thêm baht khi đã tới nơi, hãy rút từ máy hoặc đổi ở quầy trong thành phố thay vì trong sân bay.',
      },
      {
        q: 'Ở Thái Lan nên tiêu tiền mặt hay quẹt thẻ?',
        a: 'Cả hai. Trung tâm thương mại, khách sạn và chuỗi lớn nhận thẻ, còn chợ, quán ven đường và xe di chuyển thì quen tiền mặt. Quy đổi trước khi rút để ước lượng lượng baht cần cầm theo.',
      },
    ],
  },

  'sgd-vnd': {
    lead:
      'Đô la Singapore (SGD) là một trong các đồng tiền mạnh nhất châu Á, nên quy đổi SGD sang đồng Việt Nam (VND) cho ra con số lớn. '
      + 'Đây là cặp của công tác, du học và khám chữa bệnh — ba lý do người Việt sang Singapore nhiều nhất.',
    h2: 'Một đồng tiền được lái bằng chính tỷ giá',
    body: [
      'Điều đáng biết nhất về đô la Singapore không phải mức giá của nó mà là cách nó được điều hành. Cơ quan Tiền tệ Singapore không lái nền kinh tế bằng lãi suất như phần lớn ngân hàng trung ương khác, mà bằng chính tỷ giá: họ giữ đồng nội tệ đi trong một dải so với rổ tiền tệ của các đối tác thương mại. Kết quả là SGD ít khi có cú giật đột ngột.',
      'Một chi tiết ít người biết: đô la Singapore và đô la Brunei được hai nước công nhận ngang giá theo một thoả thuận ký từ năm 1967, và tờ tiền Brunei tiêu được ở Singapore đúng như tiền bản địa. Đó là một trong rất ít trường hợp hai đồng tiền khác nhau dùng lẫn được cho nhau.',
      'Trong chi tiêu hằng ngày, thứ hay làm lệch dự trù lại là hai dấu cộng nhỏ ở cuối thực đơn: giá đó chưa gồm phí phục vụ và thuế hàng hoá dịch vụ, cả hai đều được cộng vào lúc thanh toán.',
    ],
    tips: {
      h3: 'Ghi chú khi tiêu tiền ở Singapore',
      items: [
        'Dấu đô la ở Singapore là đô la Singapore, không phải đô la Mỹ; hãy nhìn mã SGD cho chắc.',
        'Giá nhà hàng ghi kèm hai dấu cộng là chưa gồm phí phục vụ và thuế, nên hãy quy đổi tổng cuối cùng.',
        'Tiền Brunei tiêu được tại Singapore theo tỷ lệ ngang giá, nhưng ra khỏi hai nước đó thì không.',
        'SGD hiếm khi biến động mạnh trong ngày, nên chênh lệch giữa các quầy đổi mới là thứ đáng đem ra so.',
      ],
    },
    faq: [
      {
        q: 'Vì sao tỷ giá đô la Singapore ổn định hơn nhiều đồng tiền khác?',
        a: 'Vì Cơ quan Tiền tệ Singapore điều hành chính sách qua tỷ giá thay vì qua lãi suất, giữ đồng nội tệ trong một dải so với rổ tiền tệ của các đối tác thương mại chính. Dải đó được chỉnh dần chứ không thả nổi hẳn.',
      },
      {
        q: 'Đô la Singapore và đô la Brunei có phải một không?',
        a: 'Không, đó là hai đồng tiền do hai nước phát hành riêng, nhưng theo thoả thuận từ năm 1967 chúng được nhận ngang giá lẫn nhau. Ở nơi khác, bạn phải quy đổi từng đồng theo mã riêng của nó.',
      },
    ],
  },

  'aud-vnd': {
    lead:
      'Quy đổi đô la Úc (AUD) sang đồng Việt Nam (VND) là việc mà gia đình có con du học Úc làm lại vào mỗi kỳ đóng học phí. '
      + 'Học phí chốt bằng AUD, còn số tiền đồng phải bỏ ra thì đổi theo tỷ giá của từng đợt nộp.',
    h2: 'Học phí tính bằng đô Úc, trả bằng tiền đồng',
    body: [
      'Úc nằm trong nhóm điểm du học được người Việt chọn nhiều nhất, và cách các trường thu tiền biến AUD/VND thành con số phải theo dõi: học phí ghi bằng đô la Úc, nộp theo từng kỳ, nên hai kỳ liền nhau có thể ngốn lượng tiền đồng chênh nhau đáng kể dù mức học phí không hề đổi.',
      'Bên cạnh đó là cộng đồng người Việt rất đông ở Sydney và Melbourne, với dòng tiền chạy cả hai chiều: cha mẹ gửi sang cho con, rồi con đi làm lại gửi ngược về.',
      'Đô la Úc là đồng tiền hàng hoá: nó lên xuống theo giá quặng sắt, than và theo sức mua từ Trung Quốc, chứ không chỉ theo tin trong nước. Có một chi tiết thú vị nối hai nước: Úc là nước đầu tiên phát hành tiền polymer, và tờ polymer của Việt Nam ra đời từ chính công nghệ đó.',
    ],
    tips: {
      h3: 'Ghi chú cho gia đình có con du học Úc',
      items: [
        'Giá ở Úc đã gồm thuế hàng hoá và dịch vụ, nên con số trên nhãn là con số thanh toán.',
        'Bên đó không có thông lệ tiền boa bắt buộc, tổng hoá đơn quy đổi ra là đủ.',
        'Dấu đô la tại Úc là đô la Úc; kiểm tra mã AUD trước khi đem so với giá bằng đô la Mỹ.',
        'Nếu còn nhiều kỳ học phí phía trước, xem biểu đồ nhiều năm trong {{app}} để biết kỳ này đang ở mức nào.',
      ],
    },
    faq: [
      {
        q: 'Vì sao mỗi kỳ học phí lại tốn lượng tiền đồng khác nhau?',
        a: 'Vì trường tính học phí bằng đô la Úc, còn bạn trả bằng tiền đồng theo tỷ giá ngày chuyển. Mức học phí không đổi nhưng tỷ giá đổi, nên tổng chi phí quy ra tiền Việt thay đổi theo từng đợt nộp.',
      },
      {
        q: 'Gọi đô la Úc là đồng tiền hàng hoá nghĩa là sao?',
        a: 'Xuất khẩu của Úc nghiêng mạnh về khoáng sản và năng lượng, nên nhu cầu mua những mặt hàng đó kéo theo nhu cầu mua đồng nội tệ. Vì thế tin về giá quặng hay về kinh tế Trung Quốc đôi khi tác động mạnh hơn tin trong nước.',
      },
    ],
  },

  'myr-vnd': {
    lead:
      'Quy đổi ringgit Malaysia (MYR) sang đồng Việt Nam (VND) cho ra một mốc tham chiếu quốc tế, nhưng quầy đổi trong nước thường lệch khá xa mốc đó. '
      + 'Lý do nằm ở chỗ ringgit không được phép giao dịch tự do bên ngoài Malaysia.',
    h2: 'Đồng tiền không được mang ra thị trường ngoài nước',
    body: [
      'Ringgit thuộc số ít đồng tiền châu Á chưa quốc tế hoá: ngân hàng trung ương Malaysia không cho phép giao dịch ringgit trên thị trường ngoài lãnh thổ, nên lượng tiền mặt nằm ở nước ngoài rất mỏng. Hệ quả với người Việt rất cụ thể: quầy trong nước ít khi có sẵn ringgit, và khoảng cách giữa giá mua với giá bán rộng hơn hẳn đô la Mỹ.',
      'Dù vậy cặp MYR/VND vẫn được tra đều vì hai lý do. Lao động Việt sang Malaysia làm nhà máy, đồn điền và dịch vụ là dòng người đã có từ lâu; còn công dân các nước ASEAN được miễn thị thực ngắn ngày cho nhau, nên Kuala Lumpur, Penang và Johor là điểm đi lại tiện.',
      'Trong tiêu dùng, ringgit chia thành sen và giá vẫn ghi hai chữ số lẻ, nhưng khi trả tiền mặt thì tổng hoá đơn được làm tròn tới bội số năm sen, do đồng một sen đã ngừng lưu hành. Trả bằng thẻ thì giữ nguyên phần lẻ.',
    ],
    tips: {
      h3: 'Ghi chú khi đi Malaysia',
      items: [
        'Giá bên đó viết RM đứng trước số; RM chính là ringgit, mã ISO 4217 là MYR.',
        'Đổi tiền tại các quầy trong trung tâm thương mại thường tốt hơn quầy trong sân bay.',
        'Hoá đơn tiền mặt được làm tròn tới bội số năm sen, nên nó có thể lệch chút ít so với hoá đơn trả thẻ.',
        'Mang tiền mặt vượt hạn mức qua cửa khẩu thì phải khai báo, áp cho cả nội tệ lẫn ngoại tệ.',
      ],
    },
    faq: [
      {
        q: 'Vì sao ở Việt Nam khó đổi được ringgit?',
        a: 'Vì Malaysia không cho phép giao dịch ringgit ngoài lãnh thổ, nên ngân hàng các nước khác giữ rất ít tiền mặt loại này. Nơi nào có thì cũng để khoảng cách mua bán rộng hơn, và đó là chi phí bạn gánh.',
      },
      {
        q: 'Sao hoá đơn tiền mặt ở Malaysia lệch vài sen so với tổng cộng?',
        a: 'Do cơ chế làm tròn: khi trả tiền mặt, tổng hoá đơn được kéo về bội số gần nhất của năm sen vì đồng một sen không còn lưu hành. Thanh toán bằng thẻ vẫn tính đủ phần lẻ.',
      },
    ],
  },

  'cad-vnd': {
    lead:
      'Quy đổi đô la Canada (CAD) sang đồng Việt Nam (VND) không giống quy đổi đô la Mỹ: đó là hai đồng tiền khác nhau, chỉ chung một ký hiệu. '
      + 'Trong tiếng Việt, nói "đô" thường được hiểu là đô Mỹ, nên hãy nói rõ "đô Canada" khi hỏi giá ở quầy.',
    h2: 'Kiều hối, du học và định cư ở Canada',
    body: [
      'Canada có một trong những cộng đồng người Việt lâu đời và đông đảo nhất ngoài nước, tập trung quanh Toronto, Vancouver, Montréal và Calgary. Vì thế CAD/VND vừa là cặp của kiều hối, vừa là cặp của du học và định cư — ba dòng tiền có nhịp rất khác nhau.',
      'Cái bẫy đầu tiên khi mới sang là giá niêm yết chưa gồm thuế. Canada thu thuế bán hàng ở cả cấp liên bang lẫn cấp tỉnh bang, mức tổng khác nhau theo từng tỉnh, và toàn bộ chỉ hiện ra ở quầy tính tiền. Cộng thêm tiền boa ở hàng ăn, hoá đơn cuối cùng cao hơn con số trên bảng giá.',
      'Tiền mặt bên đó cũng có nét riêng: mệnh giá một và hai đô la là tiền xu chứ không phải tờ giấy. Đồng một đô la được gọi là loonie theo con chim lặn in trên mặt xu, còn đồng hai đô la thành toonie chỉ vì ghép chữ "two" vào cái tên đó — mặt nó in con gấu Bắc Cực. Còn về tỷ giá, đô la Canada bám khá sát giá dầu, do năng lượng chiếm tỷ trọng lớn trong xuất khẩu của nước này.',
    ],
    tips: {
      h3: 'Ghi chú cho người mới sang Canada',
      items: [
        'Bảng giá bên đó chưa gồm thuế bán hàng; hãy quy đổi tổng tiền in trên hoá đơn.',
        'Tiền boa ở nhà hàng là thông lệ, máy thanh toán sẽ gợi ý sẵn các mức phần trăm.',
        'Khi so giá với hàng bên Mỹ, xem kỹ tiền tố CA$ hay US$ rồi mới kết luận bên nào rẻ.',
        'Tin về giá dầu có thể làm CAD/VND nhích, dù hai ngân hàng trung ương chẳng công bố gì.',
        'Mệnh giá một và hai đô la là tiền xu, đừng đợi tìm tờ giấy bạc cho hai mức đó.',
      ],
    },
    faq: [
      {
        q: 'Đô la Canada và đô la Mỹ có bằng nhau không?',
        a: 'Không, đó là hai đồng tiền riêng do hai ngân hàng trung ương phát hành, và tỷ giá giữa chúng đổi mỗi ngày. Cùng dùng dấu đô la nên hãy tìm mã CAD hoặc USD, hoặc tiền tố CA$ và US$.',
      },
      {
        q: 'Vì sao hoá đơn ở Canada cao hơn giá ghi trên kệ?',
        a: 'Vì thuế bán hàng liên bang và tỉnh bang được cộng ở khâu thanh toán chứ không nằm sẵn trong giá niêm yết, và mức thuế khác nhau theo từng tỉnh. Ở hàng ăn còn thêm tiền boa, nên hãy quy đổi con số cuối cùng.',
      },
    ],
  },

  'gbp-vnd': {
    lead:
      'Bảng Anh (GBP) là đồng tiền có đơn vị giá trị cao nhất trong mười hai cặp tiền có bản tiếng Việt ở đây, nên quy đổi GBP sang đồng Việt Nam (VND) cho ra con số lớn nhất. '
      + 'Đây là cặp của du học sinh và của cộng đồng người Việt đang làm việc tại Anh.',
    h2: 'Một năm thạc sĩ và những khoản trả bằng bảng',
    body: [
      'Anh là điểm du học quen thuộc của người Việt, đặc biệt vì chương trình thạc sĩ thường chỉ kéo dài một năm. Đi kèm là hàng loạt khoản phải trả bằng bảng ngay từ trước khi bay: đặt cọc chỗ ở, phí nhà trường, phụ phí y tế dành cho sinh viên quốc tế. Mỗi khoản là một lần quy đổi GBP/VND.',
      'Cộng đồng người Việt ở London, Birmingham và Manchester làm nhà hàng, tiệm nail và dịch vụ cũng dùng cặp này, nhưng theo chiều gửi tiền về. Với họ, thứ đáng theo dõi không phải biến động trong ngày mà là mặt bằng của cả tháng.',
      'Vài điểm nên nhớ khi tiêu tại Anh: giá niêm yết đã gồm thuế giá trị gia tăng nên con số trên nhãn là con số phải trả; Scotland và Bắc Ireland in tờ tiền riêng nhưng vẫn là bảng Anh, cùng một tỷ giá; và từ năm 2021 khách du lịch không còn được hoàn thuế giá trị gia tăng cho hàng mua tại Anh.',
    ],
    tips: {
      h3: 'Ghi chú cho du học sinh và người Việt ở Anh',
      items: [
        'Một bảng gồm 100 penny; trong đời thường người Anh hay nói "quid" thay cho "pound".',
        'Tờ tiền do ngân hàng ở Scotland phát hành vẫn là bảng Anh, không phải một đồng tiền khác.',
        'Hàng mua tại Anh không còn được hoàn thuế cho khách du lịch, khác với các nước trong Liên minh châu Âu.',
        'Khi máy thanh toán ở Anh hỏi có tính bằng tiền đồng không, hãy chọn trả bằng bảng.',
      ],
    },
    faq: [
      {
        q: 'Tờ tiền do ngân hàng Scotland in có tiêu được ở London không?',
        a: 'Có, đó vẫn là bảng Anh với cùng một tỷ giá, dù vài cửa hàng phía nam ít gặp nên thoạt nhìn có thể ngần ngại. Không có bước quy đổi nào giữa hai loại tờ tiền.',
      },
      {
        q: 'Mua hàng ở Anh có được hoàn thuế như bên châu Âu không?',
        a: 'Không. Chương trình hoàn thuế giá trị gia tăng cho khách du lịch tại Anh đã dừng từ năm 2021. Các nước Liên minh châu Âu thì vẫn còn, nên đừng lấy kinh nghiệm bên này áp cho bên kia.',
      },
    ],
  },
},

}

// --------------------------------------------------------------------------
// 9. RENDER
// --------------------------------------------------------------------------

/**
 * Renders a currency-pair page and a locale hub page to complete HTML.
 *
 * The generator emits finished documents rather than Liquid templates on
 * purpose: GitHub Pages builds this site and there is no local Jekyll to check
 * a template against, so the only way to actually verify what ships is to
 * render it here and read it. Each file carries front matter with nothing but a
 * `permalink`, which Jekyll honours while leaving the body untouched.
 */

// --------------------------------------------------------------------------
// primitives
// --------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

const UNESCAPES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }
const unescapeHtml = v => String(v).replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => UNESCAPES[e])

function esc(value) {
  return String(value).replace(/[&<>"']/g, c => ESCAPES[c])
}

/**
 * Substitutes {{token}} placeholders. Both an absent string and an unknown
 * token are build errors: rendering empty markup instead would sail past every
 * gate and only show up as a blank section on the live page.
 */
function t(template, ctx, key) {
  if (template == null) {
    throw new Error(`missing copy string${key ? `: ${key}` : ''} — the key is absent from the pack or misspelled`)
  }
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in ctx)) throw new Error(`unknown placeholder {{${key}}} in: ${String(template).slice(0, 70)}…`)
    return ctx[key]
  })
}

/** Display width in "SERP units": full-width scripts count double. */
function displayWidth(str) {
  let width = 0
  for (const ch of str) {
    const cp = ch.codePointAt(0)
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf)
      || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6)
    width += wide ? 2 : 1
  }
  return width
}

// --------------------------------------------------------------------------
// per-pair context
// --------------------------------------------------------------------------

/**
 * Central bank names are proper nouns, but they do have official forms in each
 * language ("European Central Bank" reads wrong on a French page). A copy pack
 * may override any of them via an optional `banks` map; anything it does not
 * cover falls back to the English name in currency-facts.mjs.
 */
function bankName(code, copy) {
  return copy?.banks?.[code] || FACTS[code]?.bank || ''
}

/** Everything a copy string may interpolate, for one (locale, pair). */
function pairContext(locale, slug, copy) {
  const { base, quote } = splitPair(slug)
  const intl = locale.intl
  const ctx = {
    app: SITE.appName,
    base,
    quote,
    baseName: currencyName(base, intl),
    quoteName: currencyName(quote, intl),
    baseSym: currencySymbol(base, intl),
    quoteSym: currencySymbol(quote, intl),
    baseCountry: countryName(base, intl) || CURRENCIES[base]?.region || base,
    quoteCountry: countryName(quote, intl) || CURRENCIES[quote]?.region || quote,
    baseBank: bankName(base, copy),
    quoteBank: bankName(quote, copy),
    baseMinor: String(minorUnit(base)),
    quoteMinor: String(minorUnit(quote)),
    provider: SITE.appName,
  }
  const market = marketKind(base, quote)
  if (market.peg) {
    // No parity figure here on purpose: a peg can be revalued or dropped, and a
    // number baked into 195 static pages would outlive the fact it states.
    const anchor = market.peg.against
    ctx.pegCode = market.pegged
    ctx.pegName = currencyName(market.pegged, intl)
    ctx.floatCode = market.other
    ctx.floatName = currencyName(market.other, intl)
    ctx.pegAnchor = anchor === 'basket' ? '' : anchor
    ctx.pegAnchorName = anchor === 'basket'
      ? (copy?.ui?.currencyBasket || 'a basket of currencies')
      : currencyName(anchor, intl)
    ctx.pegAgainst = ctx.pegAnchorName
    ctx.pegSince = String(market.peg.since)
  }
  return ctx
}

/**
 * "euro (EUR)", but "franc CFA (BCEAO) — XOF" when CLDR's own name already
 * ends in a parenthetical. French and German name the two CFA francs that way,
 * and stacking a second bracket on top reads like a typo.
 */
/** "→" reads backwards on an RTL page: the arrow must follow the text flow. */
function arrow(locale) {
  return locale.dir === 'rtl' ? '\u2190' : '\u2192'
}

function nameWithCode(code, locale) {
  const name = currencyName(code, locale.intl)
  return name.endsWith(')') ? `${name} \u2014 ${code}` : `${name} (${code})`
}

/**
 * How this pair's rate is actually determined. Three cases, three explanations:
 *
 *  bilateral — one leg is pegged to the other, so the rate is a constant
 *  anchored  — one leg is pegged to a THIRD currency, so the pair moves only
 *              through the other leg. Calling this "both currencies float"
 *              would be plainly wrong, and it applies to 18 of these pages.
 *  float     — neither leg is pegged
 *
 * A basket peg (the Kuwaiti dinar) counts as anchored, never bilateral: its
 * composition is undisclosed, so there is no parity to quote.
 */
function marketKind(base, quote) {
  const bp = FACTS[base]?.peg
  const qp = FACTS[quote]?.peg
  if (qp && qp.against === base) return { kind: 'bilateral', peg: qp, pegged: quote, other: base }
  if (bp && bp.against === quote) return { kind: 'bilateral', peg: bp, pegged: base, other: quote }
  if (bp) return { kind: 'anchored', peg: bp, pegged: base, other: quote }
  if (qp) return { kind: 'anchored', peg: qp, pegged: quote, other: base }
  return { kind: 'float' }
}

// --------------------------------------------------------------------------
// shared chrome
// --------------------------------------------------------------------------

/** <details> needs no JavaScript and keeps every link in the markup for crawlers. */
function langSwitcher(entries, current, label) {
  if (entries.length < 2) return ''
  const item = a => `<i aria-hidden="true">${a.flag}</i>${esc(a.name)}`
  const items = entries
    .map(a => (a.code === current.code
      ? `<li><span class="is-current" lang="${esc(a.lang)}">${item(a)}</span></li>`
      : `<li><a href="${esc(a.path)}"${a.alternate ? ` hreflang="${esc(a.lang)}"` : ''} lang="${esc(a.lang)}">${item(a)}</a></li>`))
    .join('')
  return `<details class="cc-langs-toggle">
<summary>${item(current)}</summary>
<nav aria-label="${esc(label)}"><ul class="cc-langs">${items}</ul></nav>
</details>`
}

function storeUrls(locale, campaign) {
  const referrer = encodeURIComponent(
    `utm_source=${SITE.host}&utm_medium=landing&utm_campaign=cc-pairs&utm_content=${campaign}`,
  )
  const play = `https://play.google.com/store/apps/details?id=${SITE.stores.androidFree}`
    + `&hl=${locale.playHl}&gl=${locale.playGl}&referrer=${referrer}`

  // A locale may override the slug — it differs in any storefront that carries
  // a localized listing — or set it empty to use the numeric id alone.
  const slug = locale.appleSlug === undefined ? SITE.stores.appleSlug : locale.appleSlug
  let apple = `https://apps.apple.com/${locale.appleCc}/app/${slug ? `${slug}/` : ''}id${SITE.stores.appleId}`
  const q = []
  if (SITE.stores.appleProviderToken) {
    q.push(`pt=${SITE.stores.appleProviderToken}`, `ct=${campaign}`)
  }
  if (locale.appleL) q.push(`l=${locale.appleL}`)
  if (q.length) apple += `?${q.join('&')}`

  return { play, apple }
}

/**
 * Badge heights differ on purpose: Google's artwork carries its own clear space
 * (67% ink), Apple's carries none, so 68 against 46 renders as two equal buttons.
 */
function ctaBlock(locale, copy, ctx, campaign, extra = '') {
  const { play, apple } = storeUrls(locale, campaign)
  const badges = `/images/badges/${locale.code}`
  return `<div class="cc-cta">
<img class="cc-cta-icon" src="/images/currency-converter/icon-pro.png" alt="" width="72" height="72" loading="lazy" decoding="async">
<div class="cc-cta-body">
<p class="cc-cta-title">${esc(t(copy.ui.getTheApp, ctx))}</p>
<ul class="cc-badges">
<li><a href="${esc(play)}" target="_blank" rel="noopener"><img src="${badges}/google-play.png" alt="${esc(t(copy.ui.playBadge, ctx))}" width="176" height="68" loading="lazy" decoding="async"></a></li>
<li><a href="${esc(apple)}" target="_blank" rel="noopener"><img src="${badges}/app-store.svg" alt="${esc(t(copy.ui.appleBadge, ctx))}" width="138" height="46" loading="lazy" decoding="async"></a></li>
</ul>
${extra}
</div>
</div>`
}

function screenshots(locale, copy, ctx) {
  const shots = [
    { key: 'home', caption: copy.ui.screenHome },
    { key: 'chart', caption: copy.ui.screenChart },
    { key: 'select', caption: copy.ui.screenSelect },
  ]
  const items = shots.map(s => {
    const stem = `/images/currency-converter/screens/${locale.code}/${s.key}`
    const alt = esc(t(copy.ui.screenshotsAlt, ctx) + t(s.caption, ctx))
    return `<li><figure>
<picture>
<source srcset="${stem}.avif" type="image/avif">
<img src="${stem}.jpg" alt="${alt}" width="420" height="933" loading="lazy" decoding="async">
</picture>
<figcaption>${esc(t(s.caption, ctx))}</figcaption>
</figure></li>`
  }).join('\n')
  return `<ul class="cc-shots">\n${items}\n</ul>`
}

function pageNote(locale, copy, ctx, extra = '') {
  const legal = locale.code === 'fr'
    ? { privacy: '/android/currency-converter-privacy-fr.html', terms: '/android/currency-converter-cgu-fr.html' }
    : { privacy: '/android/currency-converter-privacy-en.html', terms: '/android/currency-converter-cgu-en.html' }
  // <div>, not <footer>: the theme styles the bare `footer` element (centred,
  // 700px, 40px padding) and there is already one page-level footer.
  return `<div class="cc-note">
${extra}
<p><a href="/about/">${esc(t(copy.ui.author, ctx))}</a> — ${esc(t(copy.ui.disclaimer, ctx))}</p>
<p><a href="${legal.privacy}">${esc(copy.ui.privacy)}</a> · <a href="${legal.terms}">${esc(copy.ui.terms)}</a> · <a href="/contact/">${esc(copy.ui.contact)}</a></p>
</div>`
}

function appleBanner(canonical, campaign) {
  const parts = [`app-id=${SITE.stores.appleId}`, `app-argument=${canonical}`]
  if (SITE.stores.appleProviderToken) {
    parts.push(`affiliate-data=pt=${SITE.stores.appleProviderToken}&ct=${campaign}`)
  }
  return parts.join(', ')
}

const flagOf = code => (CURRENCIES[code] && CURRENCIES[code].flag) || ''

const jsonLdScript = data =>
  `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`

// --------------------------------------------------------------------------
// JSON-LD
// --------------------------------------------------------------------------

function entityNodes() {
  return [
    {
      '@type': 'Person',
      '@id': `${SITE.url}/#person`,
      name: 'Julien Millau',
      alternateName: 'devnied',
      url: `${SITE.url}/about/`,
      jobTitle: 'IT Distinguished Engineer',
      knowsAbout: ['Android development', 'iOS development', 'Foreign exchange rate conversion', 'NFC', 'EMV'],
      sameAs: [
        'https://github.com/devnied',
        'https://x.com/devnied',
        'https://www.linkedin.com/in/millau/',
      ],
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE.url}/#website`,
      url: `${SITE.url}/`,
      name: 'Julien Millau',
      publisher: { '@id': `${SITE.url}/#person` },
    },
    {
      '@type': 'MobileApplication',
      '@id': `${SITE.url}/#app-android`,
      name: SITE.appName,
      applicationCategory: 'FinanceApplication',
      applicationSubCategory: 'Currency Converter',
      operatingSystem: 'Android',
      url: `${SITE.url}/currency-converter/`,
      installUrl: `https://play.google.com/store/apps/details?id=${SITE.stores.androidFree}`,
      downloadUrl: `https://play.google.com/store/apps/details?id=${SITE.stores.androidFree}`,
      author: { '@id': `${SITE.url}/#person` },
      publisher: { '@id': `${SITE.url}/#person` },
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      isAccessibleForFree: true,
      inLanguage: SITE.appLanguages,
      featureList: SITE.featureList,
      privacyPolicy: `${SITE.url}/android/currency-converter-privacy-en.html`,
      termsOfService: `${SITE.url}/android/currency-converter-cgu-en.html`,
      sameAs: [`https://play.google.com/store/apps/details?id=${SITE.stores.androidFree}`],
    },
    {
      '@type': 'MobileApplication',
      '@id': `${SITE.url}/#app-ios`,
      name: SITE.stores.appleName,
      applicationCategory: 'FinanceApplication',
      operatingSystem: `iOS ${SITE.stores.appleMinOs}+`,
      url: `${SITE.url}/currency-converter/`,
      installUrl: `https://apps.apple.com/us/app/${SITE.stores.appleSlug}/id${SITE.stores.appleId}`,
      author: { '@id': `${SITE.url}/#person` },
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      isAccessibleForFree: true,
      isSimilarTo: { '@id': `${SITE.url}/#app-android` },
      privacyPolicy: `${SITE.url}/ios/currency-converter-privacy-en.html`,
      termsOfService: `${SITE.url}/ios/currency-converter-cgu-en.html`,
      sameAs: [`https://apps.apple.com/us/app/${SITE.stores.appleSlug}/id${SITE.stores.appleId}`],
    },
  ]
}

function pairJsonLd({ locale, slug, canonical, title, description, faq, ctx, dates }) {
  const { base, quote } = splitPair(slug)
  const mentions = [base, quote]
    .filter(code => FACTS[code]?.wikidata)
    .map(code => ({
      '@type': 'Thing',
      name: currencyName(code, locale.intl),
      identifier: code,
      sameAs: `https://www.wikidata.org/wiki/${FACTS[code].wikidata}`,
    }))

  return {
    '@context': 'https://schema.org',
    '@graph': [
      ...entityNodes(),
      {
        '@type': 'WebPage',
        '@id': `${canonical}#webpage`,
        url: canonical,
        name: title,
        description,
        inLanguage: locale.hreflang,
        isPartOf: { '@id': `${SITE.url}/#website` },
        about: { '@id': `${SITE.url}/#app-android` },
        author: { '@id': `${SITE.url}/#person` },
        datePublished: dates.published,
        dateModified: dates.modified,
        breadcrumb: { '@id': `${canonical}#breadcrumb` },
        mentions,
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${canonical}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: ctx.homeLabel, item: `${SITE.url}/` },
          { '@type': 'ListItem', position: 2, name: ctx.hubLabel, item: `${SITE.url}${hubPath(locale)}` },
          { '@type': 'ListItem', position: 3, name: `${base} ${ctx.arrow} ${quote}` },
        ],
      },
      {
        '@type': 'FAQPage',
        '@id': `${canonical}#faq`,
        inLanguage: locale.hreflang,
        mainEntity: faq.map(f => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
    ],
  }
}

// --------------------------------------------------------------------------
// pair page
// --------------------------------------------------------------------------

function renderPairPage({ locale, slug, copy, corridor, alternates, switcher, dates }) {
  const { base, quote } = splitPair(slug)
  const ctx = pairContext(locale, slug, copy)
  const canonical = `${SITE.url}${pairPath(locale, base, quote)}`
  const campaign = `${locale.code}_${slug}`

  const title = t(copy.meta.titlePair, ctx)
  const description = t(copy.meta.descPair, ctx)

  ctx.homeLabel = copy.ui.home
  ctx.hubLabel = copy.ui.hubBreadcrumb
  ctx.arrow = arrow(locale)

  // One rotating question per page: five FAQs everywhere, but not the same five,
  // so the shared block does not dominate every page's text.
  const rotating = copy.pair.faqRotating
  const pick = rotating.length
    ? [rotating[[...slug].reduce((a, c) => a + c.charCodeAt(0), 0) % rotating.length]]
    : []
  const faq = [...(corridor?.faq || []), ...copy.pair.faqAlways, ...pick]
    .map(f => ({ q: t(f.q, ctx), a: t(f.a, ctx) }))

  const jsonLd = pairJsonLd({ locale, slug, canonical, title, description, faq, ctx, dates })

  const ogLocaleAlt = alternates
    .filter(a => a.hreflang !== 'x-default' && a.code !== locale.code)
    .map(a => a.ogLocale)

  const market = marketKind(base, quote)
  const marketBlock = market.kind === 'bilateral' ? t(copy.pair.pegBlock, ctx)
    : market.kind === 'anchored' ? t(copy.pair.anchoredBlock, ctx)
      : t(copy.pair.floatBlock, ctx)

  const facts = code => {
    const f = FACTS[code] || {}
    const rows = [
      [copy.ui.factCode, code],
      [copy.ui.factSymbol, currencySymbol(code, locale.intl)],
      [copy.ui.factMinor, String(minorUnit(code))],
      [copy.ui.factRegion, countryName(code, locale.intl) || CURRENCIES[code]?.region || '—'],
    ]
    const dl = rows
      .map(([k, v]) => `<div><dt>${esc(t(k, ctx))}</dt><dd>${esc(v)}</dd></div>`)
      .join('')
    const bank = f.bank
      ? `<div><dt>${esc(t(copy.ui.factBank, ctx))}</dt><dd><a href="${esc(f.bankUrl)}" rel="noopener" target="_blank">${esc(bankName(code, copy))}</a></dd></div>`
      : ''
    return `<div class="cc-facts-col">
<h3>${esc(nameWithCode(code, locale))}</h3>
<dl>${dl}${bank}</dl>
</div>`
  }

  const relatedList = relatedPairs(slug, locale.code)
    .map(other => {
      const o = splitPair(other)
      return `<li><a href="${pairPath(locale, o.base, o.quote)}">
<span class="cc-pair-code">${flagOf(o.base)} ${o.base} ${arrow(locale)} ${flagOf(o.quote)} ${o.quote}</span>
<span class="cc-pair-name">${esc(currencyName(o.base, locale.intl))} ${arrow(locale)} ${esc(currencyName(o.quote, locale.intl))}</span>
</a></li>`
    })
    .join('')

  const inline = str => esc(String(str).replace(/\{\{app\}\}/g, SITE.appName))
  const corridorHtml = corridor
    ? `<section class="cc-corridor">
<h2>${inline(corridor.h2)}</h2>
${corridor.body.map(p => `<p>${inline(p)}</p>`).join('\n')}
${corridor.tips ? `<h3>${inline(corridor.tips.h3)}</h3>\n<ul>${corridor.tips.items.map(i => `<li>${inline(i)}</li>`).join('')}</ul>` : ''}
</section>`
    : ''

  const body = `<div class="cc">
<div class="cc-top">
<nav class="cc-crumb" aria-label="${esc(copy.ui.hubBreadcrumb)}">
<a href="/">${esc(copy.ui.home)}</a> › <a href="${hubPath(locale)}">${esc(copy.ui.hubBreadcrumb)}</a> › <span>${flagOf(base)} ${base} ${arrow(locale)} ${flagOf(quote)} ${quote}</span>
</nav>
${langSwitcher(switcher || [], locale, copy.ui.otherLanguages)}
</div>

<p class="cc-lead">${esc(corridor && corridor.lead ? t(corridor.lead, ctx) : t(copy.pair.lead, ctx))}</p>

${ctaBlock(locale, copy, ctx, campaign)}

<section class="cc-facts">
<h2>${esc(t(copy.ui.factsHeading, ctx))}</h2>
<p>${esc(t(copy.pair.factsIntro, ctx))}</p>
<div class="cc-facts-grid">${facts(base)}${facts(quote)}</div>
</section>

${corridorHtml}

<section class="cc-market">
<p>${esc(marketBlock)}</p>
</section>

<section class="cc-howto">
<h2>${esc(t(copy.ui.howToHeading, ctx))}</h2>
<ol>${copy.pair.howto.map(s => `<li>${esc(t(s, ctx))}</li>`).join('')}</ol>
</section>

${screenshots(locale, copy, ctx)}

<section class="cc-faq">
<h2>${esc(t(copy.ui.faqHeading, ctx))}</h2>
${faq.map(f => `<h3>${esc(f.q)}</h3>\n<p>${esc(f.a)}</p>`).join('\n')}
</section>

<section class="cc-rel">
<h2>${esc(t(copy.ui.relatedPairs, ctx))}</h2>
<p>${esc(t(copy.pair.relatedIntro, ctx))}</p>
<ul class="cc-pairgrid">${relatedList}</ul>
<p><a href="${hubPath(locale)}">${esc(t(copy.ui.allPairs, ctx))}</a></p>
</section>

${pageNote(locale, copy, ctx)}
</div>
${jsonLdScript(jsonLd)}`

  return document(locale, body, pairPath(locale, base, quote), {
    title: esc(t(copy.pair.h1, ctx)),
    seoTitle: esc(title),
    description: esc(description),
    appleApp: appleBanner(canonical, campaign),
    ogLocaleAlt,
    alternates,
    lastmod: dates.modified,
    published: dates.published,
    hash: dates.hash,
  })
}

// --------------------------------------------------------------------------
// hub page
// --------------------------------------------------------------------------

function renderHubPage({ locale, copy, alternates, switcher, allLocaleHubs, dates, appCurrencies }) {
  // Counts come from the app's own catalogue when it has been fetched, so a
  // locale's copy can quote the real figure instead of a rounded claim. They
  // are always defined — an undefined placeholder is a build error — and empty
  // when tools/fetch-app-currencies.mjs has not been run.
  const totals = appCurrencies?.totals || {}
  const ctx = {
    app: SITE.appName,
    provider: SITE.appName,
    count: appCurrencies ? String(appCurrencies.list.length) : '',
    fiatCount: totals.COUNTRY ? String(totals.COUNTRY) : '',
    cryptoCount: totals.CRYPTO ? String(totals.CRYPTO) : '',
  }
  const canonical = `${SITE.url}${hubPath(locale)}`
  const title = t(copy.meta.titleHub, ctx)
  const description = t(copy.meta.descHub, ctx)

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      ...entityNodes(),
      {
        '@type': 'WebPage',
        '@id': `${canonical}#webpage`,
        url: canonical,
        name: title,
        description,
        inLanguage: locale.hreflang,
        isPartOf: { '@id': `${SITE.url}/#website` },
        about: { '@id': `${SITE.url}/#app-android` },
        author: { '@id': `${SITE.url}/#person` },
        datePublished: dates.published,
        dateModified: dates.modified,
      },
    ],
  }

  const ogLocaleAlt = alternates
    .filter(a => a.hreflang !== 'x-default' && a.code !== locale.code)
    .map(a => a.ogLocale)

  const pairItems = (PAIRS_BY_LOCALE[locale.code] || []).map(slug => {
    const { base, quote } = splitPair(slug)
    return `<li><a href="${pairPath(locale, base, quote)}">
<span class="cc-pair-code">${flagOf(base)} ${base} ${arrow(locale)} ${flagOf(quote)} ${quote}</span>
<span class="cc-pair-name">${esc(currencyName(base, locale.intl))} ${arrow(locale)} ${esc(currencyName(quote, locale.intl))}</span>
</a></li>`
  }).join('\n')

  const languageItems = allLocaleHubs
    .filter(l => l.code !== locale.code)
    .map(l => `<li><a href="${l.path}" hreflang="${esc(l.hreflang)}" lang="${esc(l.hreflang)}"><i aria-hidden="true">${l.flag}</i>${esc(l.name)}</a></li>`)
    .join('')

  const proUrl = `https://play.google.com/store/apps/details?id=${SITE.stores.androidPro}`
    + `&hl=${locale.playHl}&gl=${locale.playGl}`
    + `&referrer=${encodeURIComponent(`utm_source=${SITE.host}&utm_medium=landing&utm_campaign=cc-pairs&utm_content=${locale.code}_hub_pro`)}`

  const edition = (name, note, href, store) =>
    `<li><b>${esc(name)}</b> <span>${esc(note)}</span> <a href="${esc(href)}" target="_blank" rel="noopener">${store}</a></li>`

  const editions = `<ul class="cc-editions">
${edition(copy.hub.editionFree, copy.hub.editionFreeNote, storeUrls(locale, `${locale.code}_hub_free`).play, 'Google Play')}
${edition(copy.hub.editionPro, copy.hub.editionProNote, proUrl, 'Google Play')}
${edition(copy.hub.editionIos, copy.hub.editionIosNote, storeUrls(locale, `${locale.code}_hub_ios`).apple, 'App Store')}
</ul>`

  const currencyIndex = appCurrencies && appCurrencies.list.length
    ? `<h2>${esc(t(copy.hub.supportedHeading, ctx))}</h2>
<p>${esc(t(copy.hub.supportedIntro, ctx))}</p>
<ul class="cc-codes">${appCurrencies.list.map(c => {
    const name = appCurrencies.nameFor(c.code, locale.code)
    return name ? `<li><abbr title="${esc(name)}">${esc(c.code)}</abbr></li>` : `<li>${esc(c.code)}</li>`
  }).join('')}</ul>`
    : ''

  const body = `<div class="cc">
<div class="cc-top">
<nav class="cc-crumb" aria-label="${esc(copy.ui.hubBreadcrumb)}">
<a href="/">${esc(copy.ui.home)}</a> › <span>${esc(copy.ui.hubBreadcrumb)}</span>
</nav>
${langSwitcher(switcher || [], locale, copy.ui.otherLanguages)}
</div>

<p class="cc-lead">${esc(t(copy.hub.lead, ctx))}</p>

${ctaBlock(locale, copy, ctx, `${locale.code}_hub`, editions)}

<h2>${esc(t(copy.hub.featuresHeading, ctx))}</h2>
<ul class="cc-features">${copy.hub.features.map(f => `<li>${esc(t(f, ctx))}</li>`).join('')}</ul>

${screenshots(locale, copy, { ...ctx, base: '', quote: '' })}

<h2>${esc(t(copy.hub.pairsHeading, ctx))}</h2>
<p>${esc(t(copy.hub.pairsIntro, ctx))}</p>
<ul class="cc-pairgrid">${pairItems}</ul>

${currencyIndex}

<h2>${esc(t(copy.hub.languagesHeading, ctx))}</h2>
<ul class="cc-langlist">${languageItems}</ul>

${pageNote(locale, copy, ctx)}
</div>
${jsonLdScript(jsonLd)}`

  return document(locale, body, hubPath(locale), {
    title: esc(t(copy.hub.h1, ctx)),
    seoTitle: esc(title),
    description: esc(description),
    appleApp: appleBanner(canonical, `${locale.code}_hub`),
    ogLocaleAlt,
    alternates,
    lastmod: dates.modified,
    published: dates.published,
    hash: dates.hash,
  })
}

// --------------------------------------------------------------------------

/**
 * Front matter only: Jekyll's default layout supplies <html>, the nav and the
 * footer, and header.html turns these keys into <title>, canonical, hreflang
 * and the Open Graph tags. `published` and `hash` are the generator's own
 * bookkeeping — reading them back is what lets the build keep no state file.
 * Jekyll strips all of it before anything is served.
 */
function document(locale, body, permalink, meta) {
  const q = v => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const lines = [
    'layout: default',
    `permalink: ${permalink}`,
    'img: /css/img/road.jpg',
    'sepStyle: home',
    `lang: ${locale.htmlLang}`,
    `direction: ${locale.dir}`,
    `title: ${q(meta.title)}`,
    `seo_title: ${q(meta.seoTitle)}`,
    `desc: ${q(meta.description)}`,
    `og_locale: ${locale.ogLocale}`,
    `og_image: ${SITE.ogImage}`,
    `og_image_alt: ${q(SITE.appName)}`,
    `apple_app: ${q(meta.appleApp)}`,
    `lastmod: ${meta.lastmod}`,
    `published: ${meta.published}`,
    `hash: ${meta.hash}`,
  ]
  if (meta.ogLocaleAlt.length) {
    lines.push('og_locale_alt:', ...meta.ogLocaleAlt.map(l => `  - ${l}`))
  }
  if (meta.alternates.length) {
    lines.push('alternates:')
    for (const a of meta.alternates) lines.push(`  - hreflang: ${a.hreflang}`, `    href: ${a.href}`)
  }
  return `---\n${lines.join('\n')}\n---\n${body}\n`
}

// --------------------------------------------------------------------------
// 10. GENERATE
// --------------------------------------------------------------------------

/**
 * Locales that have a copy pack, in LOCALES order.
 *
 * A pack that exists but is malformed is an error, never a silent skip: the
 * stale-file sweep would otherwise delete that locale's pages and the build
 * would still report success.
 */
function activeLocales() {
  const out = []
  for (const locale of WEB_LOCALES) {
    const copy = COPY[locale.code]
    if (!copy) continue
    if (typeof copy !== 'object') throw new Error(`COPY.${locale.code} is not an object`)
    out.push({ locale, copy, corridors: CORRIDORS[locale.code] || {} })
  }
  return out
}

/**
 * The supported-currency index, if `node tools/build.mjs currencies` has been
 * run. Absent, the hubs simply omit the index rather than inventing one.
 */
function loadAppCurrencies() {
  const file = path.join(ROOT, 'tools', 'app-currencies.json')
  const raw = readOrNull(file)
  if (!raw) return null
  const data = JSON.parse(raw)
  return {
    list: data.currencies,
    totals: data.totals,
    fetchedOn: data.fetchedOn,
    // A language the backend did not translate falls back to English rather
    // than showing a bare code with no tooltip.
    nameFor: (code, localeCode) => data.names[localeCode]?.[code] || data.names.en?.[code] || '',
  }
}

/**
 * Language-switcher entries for one pair: EVERY active locale.
 *
 * Where a locale publishes this pair, the link is a true alternate and gets an
 * hreflang. Where it does not, the link points at that locale's hub instead —
 * still a way into that language edition, but deliberately not annotated as a
 * translation of this page.
 */
function switcherForPair(slug, active) {
  const { base, quote } = splitPair(slug)
  return active.map(({ locale }) => {
    const publishes = (PAIRS_BY_LOCALE[locale.code] || []).includes(slug)
    return {
      code: locale.code,
      lang: locale.hreflang,
      name: locale.name,
      flag: locale.flag,
      alternate: publishes,
      path: publishes ? pairPath(locale, base, quote) : hubPath(locale),
    }
  })
}

function switcherForHub(active) {
  return active.map(({ locale }) => ({
    code: locale.code,
    lang: locale.hreflang,
    name: locale.name,
    flag: locale.flag,
    alternate: true,
    path: hubPath(locale),
  }))
}

/**
 * hreflang alternates for one pair: every ACTIVE locale that publishes it.
 * Never annotate a URL the generator did not produce — a 404 alternate
 * invalidates the whole cluster.
 */
function alternatesForPair(slug, active) {
  const members = active.filter(a => (PAIRS_BY_LOCALE[a.locale.code] || []).includes(slug))
  if (members.length < 2) return []
  const { base, quote } = splitPair(slug)
  const list = members.map(({ locale }) => ({
    code: locale.code,
    hreflang: locale.hreflang,
    ogLocale: locale.ogLocale,
    name: locale.name,
    path: pairPath(locale, base, quote),
    href: `${SITE.url}${pairPath(locale, base, quote)}`,
  }))
  const fallback = list.find(l => l.code === DEFAULT_LOCALE) || list[0]
  return [...list, { ...fallback, hreflang: 'x-default' }]
}

function alternatesForHub(active) {
  if (active.length < 2) return []
  const list = active.map(({ locale }) => ({
    code: locale.code,
    hreflang: locale.hreflang,
    ogLocale: locale.ogLocale,
    name: locale.name,
    path: hubPath(locale),
    href: `${SITE.url}${hubPath(locale)}`,
  }))
  const fallback = list.find(l => l.code === DEFAULT_LOCALE) || list[0]
  return [...list, { ...fallback, hreflang: 'x-default' }]
}

/** Content hash of everything that ends up rendered, minus the dates. */
function contentHash(str) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

const TODAY = process.env.CC_BUILD_DATE || new Date().toISOString().slice(0, 10)

/**
 * `dateModified` moves only when the page's content actually changes. Bumping
 * it on every build to look fresh is a known manipulation pattern and degrades
 * the signal rather than strengthening it.
 *
 * This is why there is no state file: the previous build's hash and dates are
 * read back out of the page it wrote, from front-matter keys that Jekyll strips
 * before anything is served.
 */
function datesFor(file, hash) {
  const raw = readOrNull(file)
  const prior = raw && {
    hash: (/^hash: (\S+)$/m.exec(raw) || [])[1],
    published: (/^published: (\S+)$/m.exec(raw) || [])[1],
    modified: (/^lastmod: (\S+)$/m.exec(raw) || [])[1],
  }
  if (prior && prior.hash === hash && prior.published && prior.modified) {
    return { published: prior.published, modified: prior.modified, hash }
  }
  return { published: prior?.published || TODAY, modified: TODAY, hash }
}

function generate({ check = false } = {}) {
  const active = activeLocales()
  if (!active.length) {
    console.error('no copy packs in COPY')
    process.exit(1)
  }

  const appCurrencies = loadAppCurrencies()
  const written = new Map()
  const manifest = []

  const hubAlternates = alternatesForHub(active)
  const hubSwitcher = switcherForHub(active)
  const allLocaleHubs = active.map(({ locale }) => ({
    code: locale.code,
    hreflang: locale.hreflang,
    name: locale.name,
    flag: locale.flag,
    path: hubPath(locale),
  }))

  for (const { locale, copy, corridors } of active) {
    // --- hub -------------------------------------------------------------
    {
      const key = hubPath(locale)
      const file = path.join(OUT_DIR, locale.code, 'hub.html')
      const args = { locale, copy, alternates: hubAlternates, switcher: hubSwitcher, allLocaleHubs, appCurrencies }
      const hash = contentHash(renderHubPage({ ...args, dates: PROBE_DATES }))
      written.set(file, renderHubPage({ ...args, dates: datesFor(file, hash) }))
      manifest.push({ url: key, locale: locale.code, type: 'hub' })
    }

    // --- pairs -----------------------------------------------------------
    for (const slug of PAIRS_BY_LOCALE[locale.code] || []) {
      const { base, quote } = splitPair(slug)
      const key = pairPath(locale, base, quote)
      const file = path.join(OUT_DIR, locale.code, `${slug}.html`)
      const args = {
        locale, slug, copy,
        corridor: corridors[slug] || null,
        alternates: alternatesForPair(slug, active),
        switcher: switcherForPair(slug, active),
      }
      let html
      try {
        const hash = contentHash(renderPairPage({ ...args, dates: PROBE_DATES }))
        html = renderPairPage({ ...args, dates: datesFor(file, hash) })
      } catch (e) {
        // Name the locale and the pair: "missing copy string" alone sends a
        // maintainer looking through fifteen packs.
        throw new Error(`${locale.code}/${slug}: ${e.message}`)
      }
      written.set(file, html)
      manifest.push({ url: key, locale: locale.code, type: 'pair', slug, hasCorridor: Boolean(args.corridor) })
    }
  }

  // llms.txt is generated output too: it belongs in the same drift check, or
  // `--check` reports a clean tree while the file on disk is out of date.
  written.set(path.join(ROOT, 'llms.txt'), llmsTxt(active, manifest))
  // The language list on the home page is generated so it can never drift out
  // of step with the locales that actually have a hub. Plain links rather than
  // <option>s: they work with no JavaScript and a crawler can follow them.
  written.set(
    path.join(ROOT, '_includes', 'currency-locales.html'),
    `<!-- GENERATED by tools/build.mjs — do not edit. -->\n${
      active.map(({ locale }) =>
        `<li><a href="${hubPath(locale)}" hreflang="${locale.hreflang}" lang="${locale.hreflang}">${locale.name}</a></li>`).join('\n')
    }\n`,
  )

  // --- write / check -----------------------------------------------------
  const stale = listExisting(OUT_DIR).filter(f => !written.has(f))

  if (check) {
    const drift = [...written].filter(([file, html]) => readOrNull(file) !== html).map(([f]) => f)
    if (drift.length || stale.length) {
      console.error(`out of date: ${drift.length} changed, ${stale.length} stale`)
      for (const f of [...drift, ...stale].slice(0, 10)) console.error(`  ${path.relative(ROOT, f)}`)
      process.exit(1)
    }
    console.log(`up to date — ${written.size} pages`)
    return
  }

  for (const f of stale) fs.rmSync(f)
  for (const [file, html] of written) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (readOrNull(file) !== html) fs.writeFileSync(file, html)
  }

  const byLocale = active.map(({ locale }) => `${locale.code}:${(PAIRS_BY_LOCALE[locale.code] || []).length}`).join(' ')
  const noCorridor = manifest.filter(m => m.type === 'pair' && !m.hasCorridor).length
  console.log(`generated ${written.size} pages across ${active.length} locales (${byLocale})`)
  if (stale.length) console.log(`removed ${stale.length} stale pages`)
  if (noCorridor) console.log(`WARNING: ${noCorridor} pair pages have no corridor block yet`)
  if (!appCurrencies) {
    console.log('NOTE: no tools/app-currencies.json — run `node tools/build.mjs currencies` to list every supported currency on the hubs')
  }
}

/** Dates the hash is computed over, so the hash never depends on the dates. */
const PROBE_DATES = { published: 'X', modified: 'X', hash: 'X' }

/**
 * /llms.txt — the llmstxt.org convention: an H1, a blockquote dense enough to
 * answer on its own, then curated link lists. Deliberately not a sitemap dump;
 * the point is to pre-select the high-signal pages, and the blockquote is where
 * the rate question gets pre-empted for a model that reads nothing else.
 */
function llmsTxt(active, manifest) {
  const url = SITE.url
  const enPairs = manifest.filter(m => m.locale === 'en' && m.type === 'pair')

  const lines = [
    '# Julien Millau — Currency Converter & Exchange',
    '',
    '> Currency Converter & Exchange is a mobile currency converter by independent developer',
    '> Julien Millau, free on Android (Google Play) and iOS (App Store). It converts between',
    '> 180+ world currencies and 20+ cryptocurrencies using exchange rates refreshed multiple',
    '> times daily, works fully offline from the last saved rates, and charts rates from one day',
    '> to five years. No account and no sign-in are required. The free edition is ad-supported;',
    '> the Pro edition removes the ads.',
    '>',
    '> This site publishes currency-pair reference pages in several languages. Those pages',
    '> deliberately contain NO exchange rate in their HTML: a rate changes continuously, so any',
    '> number written into a static page is wrong within the hour. They publish durable facts',
    '> instead — ISO 4217 codes and minor-unit exponents, issuing central banks, standing pegs —',
    '> and point to the app for the conversion itself.',
    '',
    'Author: Julien Millau (@devnied). Entity URI: https://julien-millau.fr/#person',
    '',
    '## The app',
    '',
    `- [Currency Converter app](${url}/currency-converter/): what the app does, every supported pair, both store links.`,
    `- [Google Play — free edition](https://play.google.com/store/apps/details?id=${SITE.stores.androidFree}): package ${SITE.stores.androidFree}.`,
    `- [Google Play — Pro edition](https://play.google.com/store/apps/details?id=${SITE.stores.androidPro}): ad-free.`,
    `- [Apple App Store](https://apps.apple.com/us/app/id${SITE.stores.appleId}): App Store ID ${SITE.stores.appleId}.`,
    `- [Android build notes](${url}/projects/Currency-Converter.html) · [iOS build notes](${url}/projects/Currency-Converter-iOS.html)`,
    '',
    '## Currency pair references (English)',
    '',
    ...enPairs.map(m => {
      const [base, quote] = m.slug.split('-').map(s => s.toUpperCase())
      return `- [${base} to ${quote}](${url}${m.url}): converts both ways; ISO 4217 facts, issuing banks, and who actually uses this pair.`
    }),
    '',
    '## Other languages',
    '',
    ...active
      .filter(a => a.locale.code !== 'en')
      .map(a => `- [${a.locale.name}](${url}${hubPath(a.locale)}): currency pair references for this market.`),
    '',
    '## Author',
    '',
    `- [About Julien Millau](${url}/about/): IT Distinguished Engineer; independent Android and iOS developer.`,
    `- [Contact](${url}/contact/)`,
    '',
    '## Optional',
    '',
    `- [Credit Card Reader NFC (EMV)](${url}/projects/Credit-Card-Reader.html): unrelated NFC/EMV Android project by the same developer.`,
    `- [Android privacy policy](${url}/android/currency-converter-privacy-en.html) · [Android terms](${url}/android/currency-converter-cgu-en.html)`,
    `- [iOS privacy policy](${url}/ios/currency-converter-privacy-en.html) · [iOS terms](${url}/ios/currency-converter-cgu-en.html)`,
    '',
  ]

  return `${lines.join('\n')}`
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function listExisting(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listExisting(p))
    else if (entry.name.endsWith('.html')) out.push(p)
  }
  return out
}

// --------------------------------------------------------------------------
// 11. VALIDATE — the gate
// --------------------------------------------------------------------------

/**
 * Gate for the generated currency pages.
 *
 *   node tools/build.mjs
 *
 * Every check here exists because getting it wrong is silent: a relative
 * canonical, an hreflang pointing at a page that was never generated, a title
 * that overruns its pixel budget, or two pages that are 80% the same text all
 * fail without any error message anywhere. Exits non-zero on the first class of
 * problem so this can gate a commit.
 */

/* Left un-indented on purpose: re-indenting would alter the multi-line template
   literals this code builds its error messages with. */
function validate() {
const FASTLANE = process.env.FASTLANE_DIR || '/Users/julien/Documents/Currency/fastlane/metadata/android'

/** Latin titles get 60 SERP units, CJK 30 — German compounds overrun sooner. */
const TITLE_BUDGET = { default: 60, de: 55, ja: 30, ko: 30, zh: 30 }
const DESC_BUDGET = { default: 158, ja: 80, ko: 80, zh: 80 }

const MAX_JACCARD = 0.4
const MAX_CONTAINMENT = 0.55
const MAX_HTML_BYTES = 60_000
/** What the browser actually downloads. GitHub Pages serves HTML gzipped. */
const MAX_TRANSFER_BYTES = 14_000

const FORBIDDEN_LD_KEYS = [
  'aggregateRating', 'review', 'ratingValue', 'reviewCount',
  'ExchangeRateSpecification', 'currentExchangeRate', 'MonetaryAmount',
  'HowTo', 'speakable', 'softwareVersion',
]

/** URLs Jekyll produces from _posts (permalink: none → /:categories/:title.html). */
const POST_URLS = new Set(
  fs.existsSync(path.join(ROOT, '_posts'))
    ? fs.readdirSync(path.join(ROOT, '_posts')).map(f => {
      const title = f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.(markdown|md)$/, '')
      return `/projects/${title}.html`
    })
    : [],
)

const problems = []
const warnings = []

function fail(file, message) {
  problems.push(`${file}: ${message}`)
}

function warn(file, message) {
  warnings.push(`${file}: ${message}`)
}

// --------------------------------------------------------------------------

function walk(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else if (entry.name.endsWith('.html')) out.push(p)
  }
  return out
}

function attr(html, re) {
  const m = html.match(re)
  return m ? m[1] : null
}

function loadStoreNgrams(localeCode) {
  const locale = BY_CODE[localeCode]
  const file = path.join(FASTLANE, locale.fastlane, 'full_description.txt')
  if (!fs.existsSync(file)) return null
  const raw = fs.readFileSync(file, 'utf8')
  // Same width as the page side, so the two sets are comparable.
  return ngrams(tokenize(raw), isCjkFile(raw) ? 16 : 8)
}

function isCjkFile(raw) {
  return measure(raw).cjk
}

// --------------------------------------------------------------------------

const files = walk(OUT_DIR)
if (!files.length) {
  console.error('no generated pages found')
  process.exit(1)
}

/** url → file, so hreflang targets can be checked against real output. */
let builtMissing = 0
const generatedUrls = new Set()
const pages = []

/**
 * Front matter is the sitemap's data source now, so it is parsed rather than
 * pattern-matched: the Liquid template in sitemap.xml reads `lastmod` and
 * `alternates` from here, and a page missing them drops silently out of the
 * sitemap with no error anywhere.
 */
function parseFrontMatter(raw, rel) {
  const end = raw.indexOf('\n---\n', 4)
  if (!raw.startsWith('---\n') || end === -1) {
    fail(rel, 'missing or malformed front matter')
    return null
  }
  const yaml = raw.slice(4, end)
  const body = raw.slice(end + 5)
  const data = { alternates: [] }
  let current = null
  for (const line of yaml.split('\n')) {
    if (!line.trim()) continue
    const scalar = line.match(/^([a-zA-Z_]+):\s*(.*)$/)
    if (scalar && scalar[2] !== '') {
      data[scalar[1]] = scalar[2]
      current = null
      continue
    }
    if (scalar) { current = scalar[1]; continue }
    const item = line.match(/^\s*-\s*hreflang:\s*(\S+)$/)
    if (item && current === 'alternates') { data.alternates.push({ hreflang: item[1] }); continue }
    const href = line.match(/^\s+href:\s*(\S+)$/)
    if (href && data.alternates.length) { data.alternates[data.alternates.length - 1].href = href[1]; continue }
    const plain = line.match(/^\s*-\s*(\S+)$/)
    if (plain && current === 'og_locale_alt') { (data.og_locale_alt ||= []).push(plain[1]); continue }
    fail(rel, `front matter line the sitemap template cannot read: "${line}"`)
  }
  return { data, body }
}

for (const file of files) {
  const rel = path.relative(ROOT, file)
  const raw = fs.readFileSync(file, 'utf8')
  const parsed = parseFrontMatter(raw, rel)
  if (!parsed) continue

  const url = parsed.data.permalink
  if (!url) {
    fail(rel, 'front matter has no permalink')
    continue
  }
  if (!url.startsWith('/') || !url.endsWith('/')) fail(rel, `permalink must start and end with "/": ${url}`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.data.lastmod || '')) {
    fail(rel, `front matter lastmod is missing or not a date: "${parsed.data.lastmod}" — the page would have no <lastmod> in the sitemap`)
  }
  generatedUrls.add(url)
  pages.push({
    rel, file, url, html: parsed.body, front: parsed.data,
    locale: path.basename(path.dirname(file)),
  })
}

for (const page of pages) {
  const { rel, html, url, locale: code } = page
  const locale = BY_CODE[code]
  if (!locale) {
    fail(rel, `unknown locale directory "${code}"`)
    continue
  }

  // --- Liquid safety ------------------------------------------------------
  // Jekyll renders these files through Liquid; a stray {{ or {% would either
  // blow up the build or silently delete content.
  if (/\{\{|\{%/.test(html)) fail(rel, 'output contains Liquid delimiters ({{ or {%)')

  // These pages are Jekyll content, so <html>, <head> and the nav come from
  // _layouts/default.html. What the page still owns is its front matter.
  const fm = page.front
  if (fm.layout !== 'default') fail(rel, `front matter layout is "${fm.layout}", expected "default"`)
  if (fm.lang !== locale.htmlLang) fail(rel, `front matter lang is "${fm.lang}", expected "${locale.htmlLang}"`)
  if (fm.direction !== locale.dir) fail(rel, `front matter direction is "${fm.direction}", expected "${locale.dir}"`)
  if (!fm.title) fail(rel, 'front matter has no title — the layout renders it as the <h1>')

  // --- title / description budgets ---------------------------------------
  const unq = v => unescapeHtml(String(v || '').replace(/^"|"$/g, '').replace(/\\"/g, '"'))
  const title = unq(fm.seo_title)
  const desc = unq(fm.desc)
  const titleBudget = TITLE_BUDGET[code] || TITLE_BUDGET.default
  const descBudget = DESC_BUDGET[code] || DESC_BUDGET.default
  if (!title) fail(rel, 'no <title>')
  else if (displayWidth(title) > titleBudget) {
    fail(rel, `title is ${displayWidth(title)} units, budget ${titleBudget}: "${title}"`)
  }
  if (!desc) fail(rel, 'no meta description')
  else if (displayWidth(desc) > descBudget) {
    fail(rel, `description is ${displayWidth(desc)} units, budget ${descBudget}`)
  }
  if (title && /\|\s*Julien/i.test(title)) fail(rel, 'title carries a personal-brand suffix')

  // header.html builds the canonical from page.url, so validating the permalink
  // above is what validates the canonical.
  const expected = `${SITE.url}${url}`

  // --- hreflang -----------------------------------------------------------
  const alts = page.front.alternates || []
  if (alts.length) {
    const selfRef = alts.some(a => a.href === expected && a.hreflang === locale.hreflang)
    if (!selfRef) fail(rel, 'hreflang cluster has no self-reference')
    if (!alts.some(a => a.hreflang === 'x-default')) fail(rel, 'hreflang cluster has no x-default')
    for (const a of alts) {
      if (!a.href.startsWith(`${SITE.url}/`)) fail(rel, `relative or foreign hreflang href: ${a.href}`)
      const target = a.href.slice(SITE.url.length)
      if (!generatedUrls.has(target)) fail(rel, `hreflang points at a page that was not generated: ${target}`)
      if (!/^([a-z]{2}(-[A-Z]{2}|-Han[st])?|x-default)$/.test(a.hreflang)) {
        fail(rel, `invalid hreflang value "${a.hreflang}"`)
      }
    }
  }

  // --- structured data ----------------------------------------------------
  const ld = attr(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/)
  if (!ld) fail(rel, 'no JSON-LD')
  else {
    let parsed
    try {
      parsed = JSON.parse(ld)
    } catch (e) {
      fail(rel, `JSON-LD does not parse: ${e.message}`)
    }
    if (parsed) {
      const flat = JSON.stringify(parsed)
      for (const key of FORBIDDEN_LD_KEYS) {
        if (flat.includes(`"${key}"`)) fail(rel, `JSON-LD contains forbidden key "${key}"`)
      }
      const faqNode = (parsed['@graph'] || []).find(n => n['@type'] === 'FAQPage')
      if (faqNode) {
        const text = visibleText(html)
        for (const q of faqNode.mainEntity) {
          // The schema must mirror what a human can read on the page.
          const needle = q.name.replace(/\s+/g, ' ').slice(0, 40)
          if (!text.includes(needle)) fail(rel, `FAQ question not visible on page: "${q.name}"`)
        }
      }
    }
  }

  // --- the site does not convert currency ---------------------------------
  // These pages present the app; the conversion happens in the app. Anything
  // interactive here would put the site in competition with the product and
  // would need a rate, which is the thing that cannot be published statically.
  for (const tag of ['<input', '<form', '<textarea', '<select', '<button']) {
    if (html.includes(tag)) fail(rel, `page contains ${tag}> — these pages carry no interactive widget`)
  }
  if (/<script\b(?![^>]*type="application\/ld\+json")/.test(html)) {
    fail(rel, 'page runs a script — the only <script> allowed is the JSON-LD block')
  }

  // --- document structure & accessibility ---------------------------------
  const headings = [...html.matchAll(/<h([1-6])[^>]*>/g)].map(m => Number(m[1]))
  const h1s = headings.filter(h => h === 1).length
  if (h1s) fail(rel, `${h1s} <h1> in the body — the layout already renders one from front matter`)
  for (let i = 1; i < headings.length; i++) {
    if (headings[i] - headings[i - 1] > 1) {
      fail(rel, `heading level jumps from h${headings[i - 1]} to h${headings[i]}`)
      break
    }
  }
  for (const img of html.matchAll(/<img\b[^>]*>/g)) {
    const tag = img[0]
    // A missing alt is invisible to a sighted reviewer and fatal to a screen
    // reader; missing dimensions guarantee layout shift on a lazy-loaded image.
    if (!/\salt="/.test(tag)) fail(rel, `<img> without alt: ${tag.slice(0, 80)}`)
    if (!/\swidth="\d+"/.test(tag) || !/\sheight="\d+"/.test(tag)) {
      fail(rel, `<img> without explicit width/height: ${tag.slice(0, 80)}`)
    }
  }
  // `<th(?=[\s>])` so this does not also match `<thead>`.
  for (const th of html.matchAll(/<th(?=[\s>])(?![^>]*\bscope=)[^>]*>/g)) {
    fail(rel, `<th> without scope: ${th[0].slice(0, 60)}`)
  }
  // --- third-party origins fetched at render time -------------------------
  // Only resources the browser actually loads count. hreflang and canonical
  // are metadata links, and they are absolute by requirement.
  for (const m of html.matchAll(/<(script|link|img|source)\b([^>]*)>/g)) {
    const [, tag, attrs] = m
    // Metadata and connection hints are not loaded resources.
    if (tag === 'link' && /\brel="(alternate|canonical|preconnect|dns-prefetch)"/.test(attrs)) continue
    const url = attrs.match(/\b(?:src|srcset|href)="(https?:\/\/[^"\s]+)"/)?.[1]
    if (url && !url.startsWith(`${SITE.url}/`)) {
      fail(rel, `page loads a third-party resource at render time: ${url}`)
    }
  }

  // --- no sneaky redirect -------------------------------------------------
  if (/http-equiv=["']refresh|location\s*\.\s*(href|replace|assign)/i.test(html)) {
    fail(rel, 'page contains an automatic redirect')
  }

  // --- weight -------------------------------------------------------------
  // Measure the page Jekyll actually built when there is one: the source file is
  // only the body, so weighing it would flatter the real transfer size.
  const built = path.join(ROOT, '_site', url.replace(/^\//, ''), 'index.html')
  const served = fs.existsSync(built) ? fs.readFileSync(built, 'utf8') : html
  if (served === html) builtMissing++
  const bytes = Buffer.byteLength(served, 'utf8')
  if (bytes > MAX_HTML_BYTES) fail(rel, `HTML is ${(bytes / 1024).toFixed(1)} KB, budget ${MAX_HTML_BYTES / 1024} KB`)
  const transfer = zlib.gzipSync(Buffer.from(served, 'utf8'), { level: 9 }).length
  page.transfer = transfer
  if (transfer > MAX_TRANSFER_BYTES) {
    fail(rel, `${(transfer / 1024).toFixed(1)} KB over the wire, budget ${MAX_TRANSFER_BYTES / 1024} KB`)
  }

  for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
    if (!m[1].includes('src=')) continue
    if (!/\bdefer\b|\basync\b/.test(m[1])) fail(rel, `render-blocking script: <script${m[1]}>`)
  }
  for (const m of html.matchAll(/<img\b([^>]*)>/g)) {
    if (!/loading="lazy"/.test(m[1])) fail(rel, 'an image is not lazy-loaded — these pages have no above-the-fold image')
  }

  // --- internal links resolve --------------------------------------------
  for (const m of html.matchAll(/href="(\/[^"#?]*)"/g)) {
    const href = m[1]
    if (generatedUrls.has(href)) continue
    if (href.startsWith('/css/') || href.startsWith('/js/') || href.startsWith('/images/')) {
      if (!fs.existsSync(path.join(ROOT, href.replace(/^\//, '')))) fail(rel, `asset not found: ${href}`)
      continue
    }
    const asFile = path.join(ROOT, href.replace(/^\//, ''))
    const asPage = href.replace(/^\/|\/$/g, '')
    const candidates = [asFile, `${asFile}.html`, path.join(ROOT, `${asPage}.html`)]
    // Pages Jekyll renders from _posts have no matching file at that path.
    const knownPermalink = ['/', '/about/', '/contact/', '/tag/'].includes(href)
      || POST_URLS.has(href)
    if (!knownPermalink && !candidates.some(c => fs.existsSync(c))) {
      fail(rel, `internal link does not resolve: ${href}`)
    }
  }

  // --- every image actually exists ----------------------------------------
  // A locale added without running sync-screenshots.mjs would otherwise ship
  // twelve pages of broken images and pass every other check.
  for (const m of html.matchAll(/<(?:img|source)\b[^>]*\b(?:src|srcset)="(\/[^"\s]+)"/g)) {
    if (!fs.existsSync(path.join(ROOT, m[1].replace(/^\//, '')))) fail(rel, `image not found: ${m[1]}`)
  }

  // --- no exchange rate written into the prose ----------------------------
  // The README promises this and the whole rate-freshness design depends on it.
  const prose = measure(html).text
  const rateLike = prose.match(/\b\d[\d.,\u00a0\u202f ]*\s*[A-Z]{3}\s*[=\u2248]\s*\d[\d.,]*\s*[A-Z]{3}\b/)
  if (rateLike) fail(rel, `an exchange rate appears in the static text: "${rateLike[0]}"`)

  // --- content volume -----------------------------------------------------
  const stats = measure(html)
  page.stats = stats
  page.grams = stats.grams
  if (!rel.endsWith('hub.html') && stats.length < stats.minimum) {
    fail(rel, `only ${stats.length} ${stats.unit} of visible text, minimum ${stats.minimum}`)
  }
}

// --- hreflang clusters, checked as a whole ----------------------------------
// Per-page checks cannot see a cluster that is missing a member, and a page
// that emits no alternates at all is indistinguishable from a genuine
// singleton. Rebuild the expected clusters from the data and compare.
{
  const seenPermalinks = new Map()
  for (const page of pages) {
    if (seenPermalinks.has(page.url)) {
      fail(page.rel, `duplicate permalink, already claimed by ${seenPermalinks.get(page.url)}`)
    }
    seenPermalinks.set(page.url, page.rel)
  }

  const localesLive = [...new Set(pages.map(p => p.locale))]
  const declared = new Map()
  for (const page of pages) {
    declared.set(page.url, new Set(
      (page.front.alternates || [])
        .filter(a => a.hreflang !== 'x-default')
        .map(a => a.href),
    ))
  }

  for (const slug of allPairSlugs()) {
    const members = localesLive
      .filter(code => (PAIRS_BY_LOCALE[code] || []).includes(slug))
      .map(code => `${SITE.url}${pairPath(BY_CODE[code], ...slug.toUpperCase().split('-'))}`)
    if (members.length < 2) continue
    for (const url of members) {
      const listed = declared.get(url.slice(SITE.url.length))
      if (!listed) {
        fail(url, 'is part of an hreflang cluster but was not generated')
        continue
      }
      for (const other of members) {
        if (!listed.has(other)) fail(url, `hreflang cluster is missing a member: ${other}`)
      }
    }
  }
}

// --- internal link graph ----------------------------------------------------
// A generated page nobody links to will sit in "Crawled – currently not
// indexed" forever, and the failure is invisible from any single page.
{
  const inbound = new Map([...generatedUrls].map(u => [u, 0]))
  for (const page of pages) {
    const seen = new Set()
    for (const m of page.html.matchAll(/href="(\/[^"#?]*)"/g)) seen.add(m[1])
    for (const href of seen) {
      if (href !== page.url && inbound.has(href)) inbound.set(href, inbound.get(href) + 1)
    }
  }
  for (const [url, count] of inbound) {
    if (count === 0) fail(url, 'no internal page links to it')
    else if (count < 3) fail(url, `only ${count} internal inbound link(s), minimum 3`)
  }
}

// --- near-duplicate detection, within a locale ------------------------------
const byLocale = new Map()
for (const p of pages) {
  if (!p.grams) continue
  if (!byLocale.has(p.locale)) byLocale.set(p.locale, [])
  byLocale.get(p.locale).push(p)
}

let worst = { score: 0 }
let worstContainment = { score: 0 }
for (const [code, group] of byLocale) {
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const score = jaccard(group[i].grams, group[j].grams)
      if (score > worst.score) worst = { score, a: group[i].rel, b: group[j].rel }
      if (score > MAX_JACCARD) {
        fail(group[i].rel, `${(score * 100).toFixed(0)}% 3-gram overlap with ${group[j].rel} (max ${MAX_JACCARD * 100}%)`)
      }
      // Jaccard is symmetric and penalises length differences, so a short page
      // whose text is almost entirely contained in a longer one can score well
      // under the threshold. Containment catches that — it is the shape a
      // reverse pair (USD/EUR against EUR/USD) naturally takes.
      const a = group[i].grams
      const b = group[j].grams
      const smaller = a.size <= b.size ? a : b
      const larger = a.size <= b.size ? b : a
      let inside = 0
      for (const g of smaller) if (larger.has(g)) inside++
      const containment = smaller.size ? inside / smaller.size : 0
      if (containment > worstContainment.score) {
        worstContainment = { score: containment, a: group[i].rel, b: group[j].rel }
      }
      if (containment > MAX_CONTAINMENT) {
        fail(group[i].rel, `${(containment * 100).toFixed(0)}% of the shorter page's 3-grams also appear in ${group[j].rel} (max ${MAX_CONTAINMENT * 100}%)`)
      }
    }
  }

  // --- overlap with the Play Store listing ---------------------------------
  const storeGrams = loadStoreNgrams(code)
  if (!storeGrams) {
    // Degrading to a warning here would make the most important gate in the
    // suite pass silently on any machine but one. Opt out explicitly instead.
    const message = `no fastlane listing at ${FASTLANE}/${BY_CODE[code].fastlane}/full_description.txt`
      + ' — set FASTLANE_DIR, or SKIP_STORE_OVERLAP=1 to accept the gap'
    if (process.env.SKIP_STORE_OVERLAP) warn(code, message)
    else fail(code, message)
    continue
  }
  for (const page of group) {
    const width = page.stats.cjk ? 16 : 8
    let shared = 0
    for (const g of ngrams(page.stats.tokens, width)) if (storeGrams.has(g)) shared++
    if (shared > 0) fail(page.rel, `${shared} long sequence(s) copied verbatim from the Play Store listing`)
  }
}

// --------------------------------------------------------------------------

const localesSeen = [...byLocale.keys()]
console.log(`checked ${pages.length} pages across ${localesSeen.length} locales (${localesSeen.join(', ')})`)
if (worst.a) console.log(`highest within-locale similarity: ${(worst.score * 100).toFixed(1)}% (${path.basename(worst.a)} vs ${path.basename(worst.b)})`)
if (worstContainment.a) console.log(`highest containment: ${(worstContainment.score * 100).toFixed(1)}% (${path.basename(worstContainment.a)} inside ${path.basename(worstContainment.b)})`)

const transfers = pages.filter(p => p.transfer).map(p => p.transfer).sort((a, b) => a - b)
if (transfers.length) {
  console.log(`transfer size: median ${(transfers[Math.floor(transfers.length / 2)] / 1024).toFixed(1)} KB, max ${(transfers[transfers.length - 1] / 1024).toFixed(1)} KB gzipped (budget ${MAX_TRANSFER_BYTES / 1024} KB)`)
}

const counts = pages.filter(p => p.stats && !p.rel.endsWith('hub.html')).map(p => p.stats.length)
if (counts.length) {
  counts.sort((a, b) => a - b)
  console.log(`body length per pair page: min ${counts[0]}, median ${counts[Math.floor(counts.length / 2)]}, max ${counts[counts.length - 1]} (words, or characters for CJK)`)
}

const missingLocales = WEB_LOCALES.filter(l => !byLocale.has(l.code)).map(l => l.code)
if (missingLocales.length) console.log(`not generated yet: ${missingLocales.join(', ')}`)
if (builtMissing) console.log(`weight measured on the source body for ${builtMissing} page(s) — run \`node tools/build.mjs serve build\` first to weigh what is actually served`)

for (const w of warnings) console.log(`WARN  ${w}`)

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}
console.log('\nall checks passed')
}

// --------------------------------------------------------------------------
// 12. FETCH — the one-shot importers
// --------------------------------------------------------------------------

/**
 * Downloads the official Google Play and App Store badges, localized, and
 * stores them in the repository.
 *
 *   node tools/fetch-badges.mjs
 *
 * They are served from julien-millau.fr rather than hotlinked: hotlinking would
 * put a request to Google and to Apple on every page load, which is exactly
 * what these pages avoid, and it would make the badge disappear the day either
 * URL changes.
 *
 * Both are the official assets, unmodified — Google's badge guidelines and
 * Apple's marketing guidelines both require the artwork to be used as supplied,
 * at the published proportions, with the clear space around it preserved.
 *
 * Apple publishes no Hindi or Arabic badge; those locales fall back to the
 * English one, which is what Apple's guidelines prescribe.
 *
 * Output: images/badges/<locale>/{google-play.png,app-store.svg}
 */

const OUT = path.join(ROOT, 'images', 'badges')

const playUrl = code =>
  `https://play.google.com/intl/${code}/badges/images/generic/${code}_badge_web_generic.png`
const appleUrl = code =>
  `https://toolbox.marketingtools.apple.com/api/v2/badges/download-on-the-app-store/black/${code}`

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const body = Buffer.from(await res.arrayBuffer())
  if (body.length < 500) throw new Error(`suspiciously small response (${body.length} bytes)`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, body)
  return body.length
}

async function fetchBadges() {
  let total = 0
  for (const locale of WEB_LOCALES) {
    const dir = path.join(OUT, locale.code)
    const results = []
    for (const [name, url] of [
      ['google-play.png', playUrl(locale.playBadge)],
      ['app-store.svg', appleUrl(locale.appleBadge)],
    ]) {
      try {
        const size = await download(url, path.join(dir, name))
        total += size
        results.push(`${name} ${(size / 1024).toFixed(1)}kB`)
      } catch (e) {
        results.push(`${name} FAILED (${e.message})`)
      }
    }
    console.log(`${locale.code.padEnd(3)} ${results.join('  ')}`)
  }
  console.log(`\n${(total / 1024).toFixed(0)} kB in ${path.relative(ROOT, OUT)}`)
}

/**
 * Pulls the list of currencies the app supports from its own backend, in every
 * language the site publishes, and freezes it into tools/lib/app-currencies.mjs.
 *
 *   CURRENCY_API_PASS=… node tools/fetch-app-currencies.mjs
 *
 * Why per language: the endpoint localizes each currency's `name` from the
 * `lang` parameter, so fetching once in English would put English currency
 * names on the Japanese and Arabic hubs. One request per locale gives every
 * edition the names the app itself shows on that device.
 *
 * Why freeze it at all: the pages claim "180+ currencies". That claim should
 * come from the app's own catalogue rather than from marketing copy, and once
 * it is in the repo each hub can list every supported currency as static,
 * crawlable HTML instead of a number nobody can check.
 *
 * Only identity is stored — codes, names, symbols, decimals, type. Rates are
 * never written to disk: they are fetched in the browser, because a rate
 * committed to git is wrong within the hour.
 *
 * The endpoint is the one the Android app calls
 * (fr.devnied.currency.rest.RestService#quote) behind the HTTP Basic
 * credentials in fr.devnied.currency.utils.CustomOkHttpClient.
 */

const HOST = process.env.CURRENCY_API_HOST || 'https://currency-new.julien-millau.fr'
const USER = process.env.CURRENCY_API_USER || 'com.currency.converter'
// Never defaulted in source: this repository is public, and the site does not
// need the credential — only this one manual, local step does.
const PASS = process.env.CURRENCY_API_PASS
const VERSION = process.env.CURRENCY_API_VERSION || '160'

/** One request, for one language. Returns the raw currency list. */
async function fetchLocale(apiLang, auth) {
  const url = `${HOST}/rest/v2/quote?lang=${encodeURIComponent(apiLang)}&v=${VERSION}&onlyCountry=false`
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for lang=${apiLang}`)

  const body = await res.json()
  const list = body.list || body.currencies || []
  if (!Array.isArray(list) || !list.length) {
    throw new Error(`unexpected payload for lang=${apiLang} — top-level keys: ${Object.keys(body).join(', ')}`)
  }
  return list
}

/** The app strips a "_suffix" from codes before use; do the same here. */
function normalise(row) {
  return {
    code: String(row.code || '').split('_')[0].toUpperCase(),
    name: (row.name || '').trim(),
    symbol: (row.symbol || '').trim(),
    decimals: typeof row.nbDecimal === 'number' ? row.nbDecimal : null,
    type: (row.type || 'COUNTRY').toUpperCase(),
  }
}

async function fetchCurrencies() {
  if (!PASS) {
    console.error('CURRENCY_API_PASS is not set.')
    console.error('The credential lives in the app source, not here:')
    console.error('  Currency/app/src/main/java/fr/devnied/currency/utils/CustomOkHttpClient.java')
    console.error('Run:  CURRENCY_API_PASS=… node tools/fetch-app-currencies.mjs')
    process.exit(1)
  }

  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64')

  // English defines the catalogue — codes, symbols, decimals and types come
  // from it, and the other languages contribute nothing but names.
  const english = WEB_LOCALES.find(l => l.code === 'en')
  const base = new Map()
  for (const row of (await fetchLocale(english.apiLang, auth)).map(normalise)) {
    if (!/^[A-Z]{3,5}$/.test(row.code) || base.has(row.code)) continue
    base.set(row.code, { code: row.code, type: row.type, symbol: row.symbol, decimals: row.decimals })
  }
  console.log(`en: ${base.size} currencies`)

  const names = {}
  for (const locale of WEB_LOCALES) {
    try {
      const rows = (await fetchLocale(locale.apiLang, auth)).map(normalise)
      const map = {}
      for (const row of rows) {
        if (base.has(row.code) && row.name) map[row.code] = row.name
      }
      names[locale.code] = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)))
      const missing = base.size - Object.keys(map).length
      console.log(`${locale.code} (lang=${locale.apiLang}): ${Object.keys(map).length} names${missing ? `, ${missing} untranslated` : ''}`)
    } catch (e) {
      // A language the backend does not know is not fatal: that edition falls
      // back to the English name, which is better than no list at all.
      console.warn(`${locale.code}: ${e.message} — falling back to English names`)
    }
  }

  const currencies = [...base.values()].sort((a, b) => a.code.localeCompare(b.code))
  const totals = currencies.reduce((acc, c) => ({ ...acc, [c.type]: (acc[c.type] || 0) + 1 }), {})
  const fetchedOn = new Date().toISOString().slice(0, 10)

  const out = `/**
 * Currencies supported by Currency Converter & Exchange, with their names in
 * every language the site publishes.
 *
 * GENERATED by tools/fetch-app-currencies.mjs from the app's own backend
 * (${HOST}/rest/v2/quote, one request per language).
 * Do not edit by hand — re-run the script.
 *
 * Fetched: ${fetchedOn}
 * Totals: ${Object.entries(totals).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ')} — ${currencies.length} in all.
 *
 * Rates are deliberately absent: they are fetched in the browser at runtime.
 */
const FETCHED_ON = ${JSON.stringify(fetchedOn)}
const TOTALS = ${JSON.stringify(totals)}
const APP_CURRENCIES = ${JSON.stringify(currencies, null, 2)}
const APP_CURRENCY_NAMES = ${JSON.stringify(names, null, 2)}
`

  const dest = path.join(ROOT, 'tools', 'lib', 'app-currencies.mjs')
  fs.writeFileSync(dest, out)
  console.log(`\nwrote ${path.relative(ROOT, dest)} — ${currencies.length} currencies (${
    Object.entries(totals).map(([k, v]) => `${k}: ${v}`).join(', ')}) in ${Object.keys(names).length} languages`)
  console.log('Now run: node tools/build.mjs')
}

/**
 * Copies the localized Play Store screenshots produced by fastlane into the
 * website, downscaled and re-encoded so a landing page stays light.
 *
 *   node tools/sync-screenshots.mjs [--fastlane <path>] [--force]
 *
 * Each web locale gets its OWN screenshots (the app UI is translated), which
 * is what makes a localized landing page genuinely different from its English
 * counterpart rather than a translated shell around the same image.
 *
 * Output: images/currency-converter/screens/<locale>/<name>.{avif,jpg}
 * `sips` ships with macOS and writes both formats, so there is no dependency
 * to install.
 */

const DEFAULT_FASTLANE = '/Users/julien/Documents/Currency/fastlane'

/** Screens kept on the web, in display order, with their alt-text key. */
const SCREENS = [
  { file: '0_home.png', key: 'home' },
  { file: '2_chart.png', key: 'chart' },
  { file: '1_select_currency.png', key: 'select' },
]

const TARGET_WIDTH = 420 // 2x the ~210px rendered width

function parseArgs(argv) {
  const args = { fastlane: DEFAULT_FASTLANE, force: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fastlane') args.fastlane = argv[++i]
    else if (argv[i] === '--force') args.force = true
  }
  return args
}

function sips(args) {
  execFileSync('sips', args, { stdio: ['ignore', 'ignore', 'pipe'] })
}

function syncScreenshots() {
  const { fastlane, force } = parseArgs(process.argv.slice(2))
  const metadata = path.join(fastlane, 'metadata', 'android')
  if (!fs.existsSync(metadata)) {
    console.error(`fastlane metadata not found: ${metadata}`)
    process.exit(1)
  }

  const outRoot = path.join(ROOT, 'images', 'currency-converter', 'screens')
  let written = 0
  let skipped = 0

  for (const locale of WEB_LOCALES) {
    const src = path.join(metadata, locale.fastlane, 'images', 'phoneScreenshots')
    if (!fs.existsSync(src)) {
      console.warn(`! no screenshots for ${locale.code} (${locale.fastlane})`)
      continue
    }
    const dst = path.join(outRoot, locale.code)
    fs.mkdirSync(dst, { recursive: true })

    for (const screen of SCREENS) {
      const from = path.join(src, screen.file)
      if (!fs.existsSync(from)) {
        console.warn(`! missing ${locale.code}/${screen.file}`)
        continue
      }
      for (const [format, ext, quality] of [
        ['avif', 'avif', '60'],
        ['jpeg', 'jpg', '72'],
      ]) {
        const to = path.join(dst, `${screen.key}.${ext}`)
        if (!force && fs.existsSync(to) && fs.statSync(to).mtimeMs > fs.statSync(from).mtimeMs) {
          skipped++
          continue
        }
        sips([
          '-s', 'format', format,
          '-s', 'formatOptions', quality,
          '--resampleWidth', String(TARGET_WIDTH),
          from,
          '--out', to,
        ])
        written++
      }
    }
  }

  const bytes = walkSize(outRoot)
  console.log(`screenshots: ${written} written, ${skipped} up to date, ${(bytes / 1024 / 1024).toFixed(2)} MB total`)
}

function walkSize(dir) {
  if (!fs.existsSync(dir)) return 0
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    total += entry.isDirectory() ? walkSize(p) : fs.statSync(p).size
  }
  return total
}

// --------------------------------------------------------------------------
// 13. CLI
// --------------------------------------------------------------------------

/**
 * Serving uses the same Jekyll GitHub Pages runs (3.10), out of a private
 * GEM_HOME so the repo needs no Gemfile and nothing lands in the system gems.
 * The explicit Homebrew Ruby is not optional: `ffi`, `i18n` and `public_suffix`
 * all require Ruby >= 3, and the rbenv 2.7 that comes first in PATH on this
 * machine cannot resolve Jekyll's dependency tree at all.
 */
function serve(mode) {
  const gemHome = process.env.JEKYLL_GEM_HOME || path.join(process.env.HOME, '.local', 'share', 'jekyll-gems')
  const env = {
    ...process.env,
    GEM_HOME: gemHome,
    PATH: `/opt/homebrew/opt/ruby/bin:${path.join(gemHome, 'bin')}:${process.env.PATH}`,
  }
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', env, cwd: ROOT })

  if (!fs.existsSync(path.join(gemHome, 'bin', 'jekyll'))) {
    console.log(`Installing Jekyll 3.10 into ${gemHome} \u2026`)
    // webrick left the standard library in Ruby 3; kramdown-parser-gfm is the
    // markdown flavour the posts are written in.
    run('gem', ['install', 'jekyll', '-v', '3.10.0', 'kramdown-parser-gfm', 'webrick', '--no-document'])
  }

  const common = ['--source', '.', '--destination', '_site']
  if (mode === 'build') return run('jekyll', ['build', ...common])
  run('jekyll', ['serve', ...common, '--port', process.env.PORT || '4000', '--host', '127.0.0.1'])
}

const USAGE = `usage: node tools/build.mjs [command]

  (none)        generate pages/currency/** then validate
  --check       fail if the tree on disk is out of date, write nothing
  serve         jekyll serve on http://127.0.0.1:4000/
  serve build   one-off jekyll build into _site/
  badges        re-download the official store badges
  currencies    refresh tools/app-currencies.json from the app backend
  screenshots   re-import screenshots from the fastlane tree`

const [command, sub] = process.argv.slice(2).filter(a => !a.startsWith('-'))
const CHECK = process.argv.includes('--check')

try {
  switch (command) {
    case undefined:
      generate({ check: CHECK })
      // Generating without validating is what lets a broken page reach a
      // commit, so the gate is not a separate command anyone can forget.
      if (!CHECK) validate()
      break
    case 'serve': serve(sub); break
    case 'badges': await fetchBadges(); break
    case 'currencies': await fetchCurrencies(); break
    case 'screenshots': syncScreenshots(); break
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`)
      process.exit(1)
  }
} catch (e) {
  console.error(e.message || e)
  process.exit(1)
}
