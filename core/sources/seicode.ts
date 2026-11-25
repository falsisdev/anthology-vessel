import type { StreamCandidate } from "vessel";
import { configString } from "../config.ts";
import { buildHeaders, fetchJson } from "../http.ts";
import { ultraClean } from "../text.ts";
import { collectAnimeSearchTitles } from "../tmdb.ts";
import type { ResolvedTmdbIdentity } from "../tmdb.ts";
import { extractByEmbedUrl } from "../../extractors/video-hosts.ts";

export const SEICODE_TMDB_MAP: Record<string, string> = {
  "30984": "bleach",
  "30991": "cowboy-bebop",
  "45790": "jojos-bizarre-adventure",
  "56568": "nana",
  "62602": "blue-spring-ride",
  "62640": "nisekoi",
  "63926": "one-punch-man",
  "65942": "re-zero-starting-life-in-another-world-",
  "66348": "re-zero-kara-hajimeru-break-time",
  "72517": "classroom-of-the-elite",
  "76758": "hinamatsuri",
  "78483": "kakuriyo-bed-breakfast-for-spirits-",
  "79166": "grand-blue-dreaming",
  "80564": "banana-fish",
  "82684": "that-time-i-got-reincarnated-as-a-slime",
  "82739": "rascal-does-not-dream-of-bunny-girl-senpai",
  "83121": "kaguya-sama-love-is-war",
  "85937": "demon-slayer-kimetsu-no-yaiba",
  "86034": "arifureta-from-commonplace-to-worlds-strongest",
  "88040": "given",
  "91768": "ascendance-of-a-bookworm",
  "91801": "welcome-to-demon-school-iruma-kun",
  "93241": "uzumaki",
  "94664": "mushoku-tensei-jobless-reincarnation",
  "95269": "toilet-bound-hanako-kun",
  "95479": "jujutsu-kaisen",
  "96316": "rent-a-girlfriend",
  "97525": "to-your-eternity",
  "97782": "kuma-kuma-kuma-bear",
  "100281": "moriarty-the-patriot",
  "100436": "akudama-drive",
  "107255": "dragon-raja-the-blazing-dawn-",
  "110837": "bungo-stray-dogs-wan",
  "111576": "shadows-house",
  "113808": "seirei-gensouki-spirit-chronicles",
  "117465": "hells-paradise",
  "120089": "spy-x-family",
  "123249": "my-dress-up-darling",
  "123542": "link-click",
  "127532": "solo-leveling",
  "130237": "aharen-san-wa-hakarenai",
  "131041": "blue-lock",
  "153217": "sparks-of-tomorrow",
  "154526": "mf-ghost",
  "154716": "link-click-the-daily-life-in-lightime",
  "154743": "the-angel-next-door-spoils-me-rotten",
  "196285": "farming-life-in-another-world",
  "196950": "witch-hat-atelier",
  "203737": "oshi-no-ko",
  "204266": "trigun-stampede",
  "205050": "shangri-la-frontier",
  "205743": "no-longer-allowed-in-another-world",
  "206799": "dark-gathering",
  "207332": "sakamoto-days",
  "207347": "blue-box",
  "213402": "campfire-cooking-in-another-world-with-my-absurd-skill",
  "216074": "25-dimensional-seduction",
  "216467": "mission-yozakura-family",
  "216523": "ron-kamonohashis-forbidden-deductions",
  "217407": "can-a-boy-girl-friendship-survive",
  "217409": "april-showers-bring-may-flowers",
  "220286": "ishura",
  "220542": "the-apothecary-diaries",
  "222623": "the-elusive-samurai",
  "223564": "the-100-girlfriends-who-really-really-really-really-really-love-you",
  "229858": "fate-strange-fake",
  "230189": "365-days-to-the-wedding",
  "231003": "lazarus",
  "231873": "oblivion-battery",
  "232230": "lord-of-mysteries",
  "232252": "delicos-nursery",
  "234538": "demon-lord-2099",
  "234776": "blue-miburo",
  "234910": "tying-the-knot-with-an-amagami-sister",
  "239761": "senpai-is-an-otokonoko",
  "239779": "true-beauty",
  "241535": "makeine-too-many-losing-heroines",
  "242143": "you-are-ms-servant",
  "244624": "the-do-over-damsel-conquers-the-dragon-emperor",
  "245285": "failure-frame-i-became-the-strongest-and-annihilated-everything-with-low-level-spells",
  "245325": "the-richest-man-in-game",
  "245842": "wistoria-wand-and-sword",
  "247045": "nyaight-of-the-living-cat",
  "247859": "honey-lemon-soda",
  "249882": "zenshu",
  "249907": "sentenced-to-be-a-hero",
  "249964": "i-may-be-a-guild-receptionist-but-ill-solo-any-boss-to-clock-out-on-time",
  "250596": "my-wife-has-no-emotion",
  "250994": "ameku-md-doctor-detective",
  "253476": "journal-with-witch",
  "254492": "hana-kimi",
  "254987": "dead-dead-demons-dededede-destruction",
  "256721": "gachiakuta",
  "256744": "flower-and-asura",
  "257603": "tsumasho",
  "258228": "momentary-lily",
  "258348": "clevatess",
  "258578": "promise-of-wizard",
  "258580": "the-most-notorious-talker-runs-the-worlds-greatest-clan",
  "258680": "anyway-im-falling-in-love-with-you",
  "258994": "medaka-kuroiwa-is-impervious-to-my-charms",
  "259559": "headhunted-to-another-world-from-salaryman-to-big-four",
  "259787": "yakuza-fiance-raise-wa-tanin-ga-ii",
  "259819": "rooster-fighter",
  "260463": "daemons-of-the-shadow-realm",
  "260523": "rock-is-a-ladys-modesty",
  "260823": "from-old-country-bumpkin-to-master-swordsman",
  "261298": "possibly-the-greatest-alchemist-of-all-time",
  "261311": "i-want-to-escape-from-princess-lessons",
  "261343": "chitose-is-in-the-ramune-bottle",
  "262141": "i-have-a-crush-at-work",
  "263330": "shiboyugi-playing-death-games-to-put-food-on-the-table",
  "270603": "the-exiled-heavy-knight-knows-how-to-game-the-system",
  "271605": "may-i-ask-for-one-final-thing",
  "271609": "dark-moon-the-blood-altar",
  "272059": "to-be-hero-x",
  "273467": "the-warrior-princess-and-the-barbaric-king",
  "274069": "kowloon-generic-romance",
  "274671": "the-beginning-after-the-end",
  "274741": "the-too-perfect-saint-tossed-aside-by-my-fiance-and-sold-to-another-kingdom",
  "276204": "bogus-skill-fruitmaster-about-that-time-i-became-able-to-eat-unlimited-numbers-of-skill-fruits-that-kill-you",
  "276253": "the-brilliant-healers-new-life-in-the-shadows",
  "277513": "theres-no-freaking-way-ill-be-your-lover-unless",
  "277665": "anne-shirley",
  "278043": "you-and-i-are-polar-opposites",
  "278196": "the-summer-hikaru-died",
  "278604": "gnosia",
  "278635": "my-gift-lvl-9999-unlimited-gacha-backstabbed-in-a-backwater-dungeon-im-out-for-revenge",
  "278816": "the-gorilla-gods-go-to-girl",
  "279182": "super-cube",
  "279216": "the-dinner-table-detective",
  "280049": "hell-mode-the-hardcore-gamer-dominates-in-another-world-with-garbage-balancing",
  "280078": "the-all-devouring-whale-homecoming",
  "281161": "noble-reincarnation-born-blessed-so-ill-obtain-ultimate-power",
  "281199": "legend-of-princess-chang-ge",
  "282946": "kunon-the-sorcerer-can-see",
  "282984": "nmeneko",
  "283360": "classicstars",
  "283428": "the-ramparts-of-ice",
  "283891": "the-holy-grail-of-eris",
  "284029": "the-cat-and-the-dragon",
  "284432": "scum-of-the-brave",
  "284444": "champignon-witch",
  "284495": "isekai-office-worker-the-other-worlds-books-depend-on-the-bean-counter",
  "284644": "my-status-as-an-assassin-obviously-exceeds-the-heros",
  "285166": "jack-of-all-trades-party-of-none",
  "285291": "reincarnated-as-a-dragon-hatchling",
  "285356": "watari-kuns-is-about-to-collapse",
  "285574": "i-want-to-love-you-till-your-dying-day",
  "285743": "you-cant-be-in-a-rom-com-with-your-childhood-friends",
  "285818": "mistress-kanan-is-devilishly-easy",
  "285933": "tune-in-to-the-midnight-heart",
  "286291": "dead-account",
  "286345": "though-i-am-an-inept-villainess",
  "287278": "mechanical-marie",
  "287591": "in-the-clear-moonlit-dusk",
  "288551": "the-klutzy-class-monitor-and-the-girl-with-the-short-skirt",
  "288659": "agents-of-the-four-seasons-dance-of-spring",
  "288971": "jaadugar-a-witch-in-mongolia",
  "290019": "i-made-friends-with-the-second-prettiest-girl-in-my-class",
  "293144": "wash-it-all-away",
  "293697": "i-want-to-end-this-love-game",
  "295071": "goodbye-lara",
  "295366": "there-was-a-cute-girl-in-the-heros-party-so-i-tried-confessing-to-her",
  "295999": "mao",
  "296286": "smoking-behind-the-supermarket-with-you",
  "296851": "si-vis-the-sound-of-heroes",
  "297438": "akane-banashi",
  "298831": "a-livid-ladys-guide-to-getting-even-how-i-crushed-my-homeland-with-my-mighty-grimoires",
  "300126": "liar-game",
  "300131": "kill-blue",
  "300267": "the-worlds-strongest-rearguard",
  "301944": "marriage-toxin",
  "304820": "always-a-catch",
  "309163": "gals-cant-be-kind-to-otaku",
  "309974": "love-unseen-beneath-the-clear-night-sky",
  "310921": "monster-eater",
  "312474": "nippon-sangoku-the-three-nations-of-the-crimson-sun",
  "312849": "rich-girl-caretaker-im-secretly-the-caregiver-of-the-most-popular-girl-in-this-rich-kid-school",
  "312949": "chainsmoker-cat",
};

export interface SeicodeEpisode {
  episode_number?: number | string;
  video_links?: Record<string, string>;
}

export interface SeicodeSeason {
  season_number?: number | string;
  episodes?: SeicodeEpisode[];
}

export interface SeicodeAnimeItem {
  slug?: string;
  english?: string;
  summary?: string;
  tmdbID?: number | string;
  genres?: string[];
  pictures?: { avatar?: string; banner?: string };
  seasons?: SeicodeSeason[];
}

export function matchSeicodeEpisode(
  seasons: SeicodeSeason[],
  targetSeason: number,
  targetEpisode: number,
): SeicodeEpisode | null {
  for (const s of seasons) {
    if ((Number(s.season_number) || 1) === targetSeason) {
      const hit = s.episodes?.find((e) => Number(e.episode_number) === targetEpisode);
      if (hit) return hit;
    }
  }
  if (seasons.length === 1) {
    const solo = seasons[0]?.episodes?.find((e) => Number(e.episode_number) === targetEpisode);
    if (solo) return solo;
  }
  for (const s of seasons) {
    const anyMatch = s.episodes?.find((e) => Number(e.episode_number) === targetEpisode);
    if (anyMatch) return anyMatch;
  }
  return (
    seasons.find((s) => (Number(s.season_number) || 1) === targetSeason)?.episodes?.[0] ??
    seasons[0]?.episodes?.[0] ??
    null
  );
}

export async function resolveSeicodeSlug(opts: {
  slug: string;
  apiBase: string;
  base: string;
  season: number;
  episode: number;
}): Promise<StreamCandidate[]> {
  const detail = await fetchJson<SeicodeAnimeItem>(
    `${opts.apiBase}/anime/${encodeURIComponent(opts.slug)}`,
    { timeoutMs: 8_000, headers: buildHeaders(`${opts.base}/`) },
  );
  const ep = detail?.seasons
    ? matchSeicodeEpisode(detail.seasons, opts.season, opts.episode)
    : null;
  const links = ep?.video_links ?? {};
  const urls = Object.values(links)
    .map((u) => (typeof u === "string" ? u.trim() : ""))
    .filter((u) => u.startsWith("http") || u.startsWith("//"));

  const results = await Promise.all(
    urls.map((u) =>
      extractByEmbedUrl(u, {
        sourceLabel: "SeiCode",
        audioType: "sub",
        language: "ja",
        referer: `${opts.base}/`,
      }),
    ),
  );
  const merged: StreamCandidate[] = [];
  for (const r of results) merged.push(...r);
  return merged;
}

export async function resolveSeicodeByIdentity(opts: {
  identity: ResolvedTmdbIdentity;
  season: number;
  episode: number;
  apiBase?: string;
  base?: string;
  exactTmdbOnly?: boolean;
}): Promise<StreamCandidate[]> {
  const apiBase = (
    opts.apiBase ??
    (await configString("urls.anime.seicode.api_base", "https://next.seicode.net"))
  ).replace(/\/+$/, "");
  const base = (
    opts.base ?? (await configString("urls.anime.seicode.base", "https://seicode.net"))
  ).replace(/\/+$/, "");

  const tmdbKey = String(opts.identity.tmdbId);
  let slug = SEICODE_TMDB_MAP[tmdbKey] ?? "";

  if (!slug) {
    for (const q of collectAnimeSearchTitles(opts.identity).slice(0, 4)) {
      const hits = await fetchJson<SeicodeAnimeItem[]>(
        `${apiBase}/anime/search?q=${encodeURIComponent(q)}`,
        { timeoutMs: 7_000, headers: buildHeaders(`${base}/`) },
      );
      const exact = (hits ?? []).find((x) => {
        if (!x.slug) return false;
        if (x.tmdbID !== undefined && String(x.tmdbID) === tmdbKey) return true;
        return !opts.exactTmdbOnly && ultraClean(x.english || "") === ultraClean(q);
      });
      if (exact?.slug) {
        slug = exact.slug;
        break;
      }
    }
  }

  if (!slug) return [];
  return resolveSeicodeSlug({
    slug,
    apiBase,
    base,
    season: opts.season,
    episode: opts.episode,
  });
}
