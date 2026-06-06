/**
 * /api/dvids — CENTCOM-filtered DVIDS feed.
 *
 * The DVIDS firehose (/rss/news/all and /rss/image/all) carries 400+ items
 * per query but nearly all are stateside National Guard / Naval training /
 * domestic Coast Guard. Their search RSS is broken — q=CENTCOM returns the
 * same items as q=Iran (we tested). So we filter ourselves.
 *
 * The filter is strict-but-narrow: high-precision MENA / CENTCOM keywords,
 * with an exclusion list to drop AFRICOM / EUCOM look-alikes (EURAFCENT,
 * Sigonella, Naples, Aviano, etc.). The output is a synthesized RSS that
 * parseRSS on the client consumes like any other source — same item shape,
 * same image extraction, same dedupe.
 *
 * Usage:
 *   GET /api/dvids                → news, CENTCOM-filtered
 *   GET /api/dvids?type=image     → imagery, CENTCOM-filtered
 *   GET /api/dvids?type=news      → explicit news
 *
 * Edge-cached 12 h fresh + 12 h stale (twice-daily refresh, matches the
 * per-host TTL we set on /api/news for the unfiltered firehose).
 */

export const config = { runtime: 'edge' };

/**
 * Per-theater include / exclude regex pairs. Strict-but-narrow — we'd
 * rather miss a borderline item than flood the deck. Exclusion lists
 * kill the most common look-alikes that share a vocabulary word with
 * the target theater.
 *
 * CENTCOM    — Middle East, Levant, Gulf, Horn of Africa, Central Asia
 * EUCOM      — Europe, Russia, Ukraine, NATO eastern flank
 * INDOPACOM  — China, Taiwan, Japan, Korea, SCS, broader Indo-Pacific
 * AFRICOM    — sub-Saharan Africa, Sahel, Horn
 * (NORTHCOM / SOUTHCOM skipped — low signal for SHIFT's brief)
 */
const THEATERS = {
  centcom: {
    label: 'CENTCOM',
    include: new RegExp([
      // Command + sub-commands
      '\\bUSCENTCOM\\b', '\\bCENTCOM\\b', '\\bU\\.S\\. Central Command\\b',
      '\\bMARCENT\\b', '\\bAFCENT\\b', '\\bARCENT\\b', '\\bNAVCENT\\b',
      '\\bUSNAVCENT\\b', '\\bSOCCENT\\b', '\\bUSAFCENT\\b',
      '\\b5th Fleet\\b', '\\bU\\.S\\. 5th Fleet\\b', '\\bFifth Fleet\\b',
      // MENA waterways
      '\\bPersian Gulf\\b', '\\bArabian Gulf\\b', '\\bArabian Sea\\b',
      '\\bStrait of Hormuz\\b', '\\bBab el[- ]Mandeb\\b', '\\bRed Sea\\b',
      '\\bSuez\\b',
      // Countries
      '\\bIran\\b', '\\bIranian\\b', '\\bIraq\\b', '\\bIraqi\\b',
      '\\bSyria\\b', '\\bSyrian\\b', '\\bYemen\\b', '\\bYemeni\\b',
      '\\bLebanon\\b', '\\bLebanese\\b', '\\bBahrain\\b', '\\bQatar\\b',
      '\\bUnited Arab Emirates\\b', '\\bU\\.A\\.E\\b', '\\bUAE\\b',
      '\\bSaudi Arabia\\b', '\\bSaudi\\b',
      '\\bKuwait\\b', '\\bOman\\b', '\\bJordan\\b', '\\bEgypt\\b',
      '\\bAfghanistan\\b', '\\bAfghan\\b',
      // Threats
      '\\bHouthi\\b', '\\bHezbollah\\b', '\\bHamas\\b',
      '\\bIRGC\\b', '\\bISIS\\b', '\\bISIL\\b', '\\bDaesh\\b',
      // Operations
      '\\bInherent Resolve\\b', '\\bProsperity Guardian\\b',
      // Forward bases
      '\\bAl Udeid\\b', '\\bAl Dhafra\\b', '\\bCamp Arifjan\\b',
      '\\bCamp Buehring\\b', '\\bNSA Bahrain\\b', '\\bManama\\b',
    ].join('|'), 'i'),
    exclude: new RegExp([
      '\\bEURAFCENT\\b', '\\bEUCOM\\b', '\\bAFRICOM\\b',
      '\\bNaples\\b', '\\bSigonella\\b', '\\bAviano\\b', '\\bSpangdahlem\\b',
      '\\bRamstein\\b', '\\bGrafenw[oö]hr\\b',
      '\\bGulf of Mexico\\b', '\\bGulf Coast\\b', '\\bGulf Stream\\b',
      '\\bAfrican Lion\\b',
    ].join('|'), 'i'),
  },

  eucom: {
    label: 'EUCOM',
    include: new RegExp([
      '\\bUSEUCOM\\b', '\\bEUCOM\\b', '\\bU\\.S\\. European Command\\b',
      '\\bNATO\\b', '\\bAllied Joint Force\\b', '\\bSACEUR\\b',
      // Naval — 6th Fleet is the Med / European Navy fleet
      '\\b6th Fleet\\b', '\\bSixth Fleet\\b',
      // Russia / Ukraine front
      '\\bUkraine\\b', '\\bUkrainian\\b', '\\bKyiv\\b',
      '\\bRussia\\b', '\\bRussian\\b', '\\bKremlin\\b', '\\bMoscow\\b',
      // Eastern flank
      '\\bPoland\\b', '\\bPolish\\b', '\\bRomania\\b', '\\bRomanian\\b',
      '\\bCzech\\b', '\\bCzechia\\b', '\\bSlovakia\\b', '\\bHungary\\b',
      '\\bBulgaria\\b', '\\bMoldova\\b',
      '\\bEstonia\\b', '\\bLatvia\\b', '\\bLithuania\\b', '\\bBaltic\\b',
      '\\bFinland\\b', '\\bSweden\\b', '\\bNorway\\b', '\\bNordic\\b',
      '\\bBlack Sea\\b',
      // Western / central Europe bases
      '\\bGermany\\b', '\\bGerman\\b', '\\bRamstein\\b', '\\bSpangdahlem\\b',
      '\\bStuttgart\\b', '\\bGrafenw[oö]hr\\b', '\\bWiesbaden\\b',
      '\\bAviano\\b', '\\bVicenza\\b', '\\bNaples\\b', '\\bSigonella\\b',
      '\\bItaly\\b', '\\bItalian\\b',
      '\\bFrance\\b', '\\bFrench\\b',
      '\\bUnited Kingdom\\b', '\\bBritish\\b', '\\bRAF Lakenheath\\b',
      '\\bRAF Mildenhall\\b', '\\bRAF Fairford\\b',
      // Exercises
      '\\bDefender Europe\\b', '\\bSaber\\b', '\\bAtlantic Resolve\\b',
    ].join('|'), 'i'),
    exclude: new RegExp([
      '\\bCENTCOM\\b', '\\bAFRICOM\\b', '\\bINDOPACOM\\b', '\\bSOUTHCOM\\b',
      // Russia + Iran/Syria headlines that are really CENTCOM
      '\\bIranian\\b.*\\bRussian\\b', '\\bRussian\\b.*\\bSyrian\\b',
    ].join('|'), 'i'),
  },

  indopacom: {
    label: 'INDOPACOM',
    include: new RegExp([
      '\\bINDOPACOM\\b', '\\bUSINDOPACOM\\b', '\\bPACOM\\b',
      '\\bIndo[- ]Pacific\\b', '\\bPacific theater\\b',
      // Naval — 7th Fleet is Western Pacific, 3rd Fleet is Eastern
      '\\b7th Fleet\\b', '\\bSeventh Fleet\\b',
      // China / Taiwan
      '\\bChina\\b', '\\bChinese\\b', '\\bPRC\\b', '\\bPLA\\b',
      '\\bPLAN\\b', '\\bPLAAF\\b', '\\bBeijing\\b', '\\bXi Jinping\\b',
      '\\bTaiwan\\b', '\\bTaiwanese\\b', '\\bTaipei\\b', '\\bTaiwan Strait\\b',
      '\\bSouth China Sea\\b', '\\bEast China Sea\\b',
      // Japan
      '\\bJapan\\b', '\\bJapanese\\b', '\\bJSDF\\b', '\\bJMSDF\\b',
      '\\bYokota\\b', '\\bKadena\\b', '\\bMisawa\\b', '\\bOkinawa\\b',
      '\\bIwakuni\\b', '\\bYokosuka\\b',
      // Korea
      '\\bSouth Korea\\b', '\\bKorea\\b', '\\bKorean\\b', '\\bROK\\b',
      '\\bCamp Humphreys\\b', '\\bOsan\\b', '\\bYongsan\\b',
      '\\bDPRK\\b', '\\bNorth Korea\\b',
      // Australia / NZ / Philippines
      '\\bAustralia\\b', '\\bAustralian\\b', '\\bRAAF\\b', '\\bADF\\b',
      '\\bPhilippines\\b', '\\bFilipino\\b', '\\bSubic Bay\\b',
      // Exercises
      '\\bTalisman Sabre\\b', '\\bCope North\\b', '\\bPacific Sentry\\b',
      '\\bBalikatan\\b', '\\bRIMPAC\\b',
    ].join('|'), 'i'),
    exclude: new RegExp([
      '\\bCENTCOM\\b', '\\bEUCOM\\b', '\\bAFRICOM\\b',
    ].join('|'), 'i'),
  },

  africom: {
    label: 'AFRICOM',
    include: new RegExp([
      '\\bUSAFRICOM\\b', '\\bAFRICOM\\b', '\\bU\\.S\\. Africa Command\\b',
      '\\bEURAFCENT\\b', // joint health unit serves AFRICOM
      // Sub-Saharan focus
      '\\bSahel\\b', '\\bSomalia\\b', '\\bSomali\\b', '\\bal[- ]Shabaab\\b',
      '\\bEthiopia\\b', '\\bEthiopian\\b',
      '\\bSudan\\b', '\\bSudanese\\b', '\\bLibya\\b', '\\bLibyan\\b',
      '\\bDjibouti\\b', '\\bCamp Lemonnier\\b',
      '\\bNiger\\b', '\\bMali\\b', '\\bBurkina Faso\\b',
      '\\bDRC\\b', '\\bDemocratic Republic of the Congo\\b',
      '\\bKenya\\b', '\\bKenyan\\b', '\\bTanzania\\b',
      '\\bMorocco\\b', '\\bMoroccan\\b', '\\bTunisia\\b', '\\bTunisian\\b',
      '\\bAlgeria\\b', '\\bAlgerian\\b',
      // Exercises
      '\\bAfrican Lion\\b', '\\bFlintlock\\b',
    ].join('|'), 'i'),
    exclude: new RegExp([
      '\\bCENTCOM\\b', '\\bEUCOM\\b', '\\bINDOPACOM\\b',
    ].join('|'), 'i'),
  },
};

const UPSTREAM = {
  news:  'https://www.dvidshub.net/rss/news/all',
  image: 'https://www.dvidshub.net/rss/image/all',
};

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5',
};

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Naïve item splitter — DVIDS items are well-formed and there's no nesting
 *  weirdness here (no item-in-item, no CDATA containing </item>). */
function splitItems(xml) {
  const out = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function pickFirst(itemXml, ...tagNames) {
  for (const tag of tagNames) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const m = itemXml.match(re);
    if (m) return m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
  }
  return '';
}

/** Decide whether to keep an item against a specific theater's regexes. */
function keepItem(itemXml, theater) {
  const text = itemXml
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ');
  if (theater.exclude.test(text)) return false;
  return theater.include.test(text);
}

export default async function handler(request) {
  const u = new URL(request.url);
  const type = u.searchParams.get('type') === 'image' ? 'image' : 'news';
  const theaterKey = (u.searchParams.get('theater') || 'centcom').toLowerCase();
  const theater = THEATERS[theaterKey];
  if (!theater) {
    return text(`Unknown theater: ${theaterKey}. Try: ${Object.keys(THEATERS).join(', ')}`, 400);
  }
  const upstreamUrl = UPSTREAM[type];

  try {
    const r = await fetch(upstreamUrl, { headers: BROWSER_HEADERS, cache: 'no-store' });
    if (!r.ok) return text(`Upstream ${r.status}`, 502);
    const xml = await r.text();

    const items = splitItems(xml).filter((it) => keepItem(it, theater));

    const channelTitle = `DVIDS · ${theater.label} (${type})`;
    const channelDesc  = `${theater.label} AOR ${type} from DVIDS, filtered server-side`;

    const out =
`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<title>${esc(channelTitle)}</title>
<link>${esc(upstreamUrl)}</link>
<description>${esc(channelDesc)}</description>
<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items.map((it) => `<item>${it}</item>`).join('\n')}
</channel>
</rss>`;

    return new Response(out, {
      status: 200,
      headers: {
        'content-type': 'application/rss+xml; charset=utf-8',
        'access-control-allow-origin': '*',
        // Twice-daily refresh, matches /api/news per-host override for DVIDS
        'cache-control': 'public, s-maxage=43200, stale-while-revalidate=43200',
        // Lightly informative — helps when debugging from curl
        'x-dvids-source': upstreamUrl,
        'x-dvids-theater': theaterKey,
        'x-dvids-kept': String(items.length),
      },
    });
  } catch (e) {
    return text(`Fetch error: ${String(e?.message || e).slice(0, 200)}`, 502);
  }
}

function text(body, status) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
  });
}
