// Title parser: messy multilingual (LT/EN/RU) card titles -> structured attributes.

const SETS = [
  ["uefa club competitions", "UEFA Club Competitions"],
  ["ucc chrome", "Topps Chrome UEFA Club"],
  ["ucc", "Topps Chrome UEFA Club"],
  ["topps inception", "Topps Inception"],
  ["inception", "Topps Inception"],
  ["select snapshots", "Select Snapshots"],
  // Named inserts. These identify a card as precisely as a set does, and without
  // them the insert name leaks into the player field and the parse is refused.
  ["kaboom", "Kaboom"],
  ["downtown", "Downtown"],
  ["color blast", "Color Blast"],
  ["stained glass", "Stained Glass"],
  ["rated rookie", "Donruss Rated Rookie"],
  ["golden baller", "Golden Baller"],
  ["bonafide baller", "Bonafide Baller"],
  ["shadow play", "Shadow Play"],
  ["star signings", "Star Signings"],
  ["future stars", "Future Stars"],
  ["wonderkid", "Wonderkids"],
  ["sapphire", "Topps Chrome Sapphire"],
  ["topps museum", "Topps Museum"],
  ["museum collection", "Topps Museum"],
  ["museum", "Topps Museum"],
  ["topps showtime", "Topps Showtime"],
  ["showtime", "Topps Showtime"],
  ["match attax", "Match Attax"],
  ["topps chrome", "Topps Chrome"],
  ["topps merlin", "Topps Merlin"],
  ["merlin", "Merlin"],
  ["megacracks", "Megacracks"],
  ["mega cracks", "Megacracks"],
  ["stadium club", "Stadium Club"],
  ["topps finest", "Topps Finest"],
  ["finest", "Finest"],
  ["topps now", "Topps Now"],
  ["topps", "Topps"],
  ["prizm world cup", "Prizm World Cup"],
  ["world cup", "World Cup"],
  ["prizm", "Prizm"],
  ["select", "Select"],
  ["mosaic", "Mosaic"],
  ["optic", "Optic"],
  ["donruss", "Donruss"],
  ["obsidian", "Obsidian"],
  ["revolution", "Revolution"],
  ["contenders", "Contenders"],
  ["immaculate", "Immaculate"],
  ["national treasures", "National Treasures"],
  ["flawless", "Flawless"],
  ["chronicles", "Chronicles"],
  ["phoenix", "Phoenix"],
  ["court kings", "Court Kings"],
  ["spectra", "Spectra"],
  ["crown royale", "Crown Royale"],
  ["noir", "Noir"],
  ["hoops", "Hoops"],
  ["bowman", "Bowman"],
  ["upper deck", "Upper Deck"],
  ["fleer", "Fleer"],
  ["skybox", "Skybox"],
  ["panini", "Panini"],
];

const VARIANTS = [
  "silver", "holo", "refractor", "mojo", "wave", "shimmer", "cracked ice",
  "ice", "disco", "hyper", "fast break", "genesis", "sapphire", "gold",
  "purple", "blue", "green", "red", "orange", "pink", "bronze", "camo",
  "auto", "autograph", "autograf", "autografas", "patch", "sepia", "x-fractor", "xfractor",
  "negative", "hologlow", "case hit", "snapshots", "power surge",
];

const VARIANT_ALIASES = {
  autograf: "auto", autograph: "auto", autografas: "auto", автограф: "auto",
  refractor: "refractor", xfractor: "x-fractor",
};

// Club/team names that pollute player extraction (never part of a player name).
const CLUBS = new Set([
  "real", "madrid", "madryt", "barcelona", "barca", "inter", "milan", "juventus",
  "napoli", "roma", "manchester", "city", "united", "liverpool", "arsenal",
  "chelsea", "tottenham", "psg", "paris", "bayern", "dortmund", "ajax", "porto",
  "benfica", "atletico", "sevilla", "spurs", "lakers", "warriors", "celtics",
  "bulls", "nets", "knicks", "heat", "mavericks", "nuggets", "bucks", "suns",
  "clippers", "grizzlies", "pelicans", "raptors", "rockets", "thunder", "wizards",
  "hawks", "hornets", "cavaliers", "pistons", "pacers", "magic", "sixers",
  "blazers", "kings", "jazz", "timberwolves", "spurs",
  // city words that precede a team name and otherwise leak into the player
  "san", "antonio", "los", "angeles", "new", "york", "golden", "state", "oklahoma",
  "portland", "sacramento", "minnesota", "orlando", "denver", "phoenix", "toronto",
  "brooklyn", "boston", "philadelphia", "cleveland", "detroit", "memphis",
  "milwaukee", "atlanta", "charlotte", "indiana", "utah", "dallas", "houston",
  "washington", "leipzig", "dortmund", "munich", "bayern", "sevilla", "valencia",
]);

// Local-language noise words (LT/RU/EN) stripped before player extraction.
const STOPWORDS = new Set([
  // English
  "card", "cards", "new", "rare", "mint", "sports", "trading", "soccer",
  "football", "basketball", "nba", "uefa", "fifa", "rookie", "rc", "the",
  "sealed", "pack", "box", "grade", "graded", "gem", "mt", "insert", "base",
  "parallel", "numbered", "limited", "edition", "no", "nr", "sale", "to", "of",
  "and", "with", "club", "competitions",
  // Polish
  "karty", "piłkarskie", "pilkarskie", "nowa", "nowe", "koszykówka", "koszykowka",
  // Lithuanian
  "kortelė", "kortele", "kortelės", "korteles", "kortelių", "korteliu",
  "karta", "korta", "kortos", "kortelę", "kortele",
  "nauja", "naujos", "naujas", "originali", "originalus", "futbolo",
  "krepšinio", "krepsinio", "žaidėjo", "zaidejo", "reta", "retos",
  "kolekcinė", "kolekcine", "kolekcinės", "kolekcines", "vnt",
  // Russian
  "карточка", "карточки", "новая", "новые", "футбол", "футбольная",
  "баскетбол", "баскетбольная", "редкая", "коллекционная", "спортивная",
]);

export function parseTitle(rawTitle, knownGrade = null) {
  const title = rawTitle.trim();
  // Punctuation is separated rather than deleted so set names carrying it
  // ("Kaboom!") still match, while "#123" and "/99" keep their meaning.
  let work = " " + title.toLowerCase().replace(/[!?,;:()[\]"'`’]+/g, " ") + " ";
  const out = {
    title,
    player: null,
    year: null,
    set: null,
    number: null,
    variant: [],
    grader: null,
    grade: null,
    rookie: false,
    serial: null,
    confidence: "low",
  };

  // Grader + grade: "PSA 10", "BGS 9.5", "SGC-10", "psa10"
  const gm = work.match(/\b(psa|bgs|sgc|cgc)\s*[-:]?\s*(10|[1-9](?:\.5)?)\b/i);
  if (gm) {
    out.grader = gm[1].toUpperCase();
    out.grade = gm[2];
    work = work.replace(gm[0], " ");
  } else if (/\b(psa|bgs|sgc|cgc|slab|graded)\b/i.test(work) === false) {
    // raw card
  }
  if (!out.grader && knownGrade) {
    const kg = String(knownGrade).match(/(psa|bgs|sgc|cgc)\s*[-:]?\s*(10|[1-9](?:\.5)?)/i);
    if (kg) { out.grader = kg[1].toUpperCase(); out.grade = kg[2]; }
  }

  // Year: 1950-2029, optional season suffix "2023-24" / "2023/24"
  const ym = work.match(/\b(19[5-9]\d|20[0-2]\d)(?:\s?[-\/]\s?(\d{2}))?\b/);
  if (ym) {
    out.year = ym[2] ? `${ym[1]}-${ym[2]}` : ym[1];
    work = work.replace(ym[0], " ");
  }

  // Serial numbering "/99" or "12/99" (before card # so it isn't eaten)
  const sm = work.match(/\b(\d{1,4})?\s?\/\s?(\d{1,4})\b/);
  if (sm && Number(sm[2]) >= 5) {
    out.serial = `/${sm[2]}`;
    work = work.replace(sm[0], " ");
  }

  // Card number: "#123", "no. 123", "nr 123"
  const nm = work.match(/(?:#|\bno\.?\s|\bnr\.?\s)\s?(\d{1,4})\b/);
  if (nm) {
    out.number = nm[1];
    work = work.replace(nm[0], " ");
  }

  // Set/brand: first match (longest-first order) is canonical; strip ALL
  // brand words so "Panini Prizm" doesn't leak "Panini" into the player name.
  for (const [needle, canonical] of SETS) {
    if (work.includes(" " + needle + " ")) {
      if (!out.set) out.set = canonical;
      work = (" " + work.replaceAll(needle, " ") + " ").replace(/\s+/g, " ");
    }
  }

  // Rookie
  if (/\b(rc|rookie|naujokas|новичок)\b/i.test(work)) {
    out.rookie = true;
    work = work.replace(/\b(rc|rookie|naujokas|новичок)\b/gi, " ");
  }

  // Variants — collapse local/alternate spellings onto the canonical token the
  // comp source uses, so "autograf" and "autograph" score identically.
  for (const v of VARIANTS) {
    if (work.includes(" " + v + " ")) {
      const canonical = VARIANT_ALIASES[v] ?? v;
      if (!out.variant.includes(canonical)) out.variant.push(canonical);
      work = work.replaceAll(" " + v + " ", " ");
    }
  }

  // Player: remaining Latin-script words minus stopwords/noise
  const tokens = work
    .replace(/[^\p{L}\p{N}' -]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t))
    .filter((t) => !CLUBS.has(t))
    .filter((t) => !/^\d+$/.test(t))
    .filter((t) => /^[a-z]/i.test(t)) // Latin-script only — proper nouns
    .filter((t) => t.length > 1);
  if (tokens.length > 0 && tokens.length <= 4) {
    out.player = tokens.map((t) => t[0].toUpperCase() + t.slice(1)).join(" ");
  } else if (tokens.length > 4) {
    // too much residue — take first 3 tokens as best guess, lower trust
    out.player = tokens.slice(0, 3).map((t) => t[0].toUpperCase() + t.slice(1)).join(" ");
  }

  // A bare manufacturer ("Topps", "Panini") names a company, not a product —
  // it can't pin down which of hundreds of sets a card belongs to.
  const setIsSpecific = out.set && !/^(topps|panini|upper deck|futera|merlin)$/i.test(out.set);

  // Confidence: need player + something that identifies the actual card.
  // A serial parallel (/50) additionally needs a real set or number, since the
  // base card and each parallel trade at completely different prices.
  if (out.player && (setIsSpecific || out.year || out.number)) {
    out.confidence = tokens.length > 4 ? "medium" : "high";
    if (out.serial && !setIsSpecific && !out.number) out.confidence = "low";
  } else {
    out.confidence = "low";
  }

  return out;
}

// True only when a grader is followed by an actual grade number. Keyword
// matching on "psa" alone is unusable here: it's Polish for "dog", so a Vinted
// feed is full of dog carriers and dog beds that are not graded cards.
export function detectSlab(title) {
  const t = String(title);
  const m = t.match(/\b(psa|bgs|sgc|cgc|beckett)\s*[-:.]?\s*(10|[1-9](?:\.5)?)\b/i);
  if (m) return { grader: m[1].toUpperCase(), grade: m[2] };
  // Slab-label wording without a grader token, e.g. "CHARIZARD GEM MT 10"
  const g = t.match(/\bgem\s*(?:mt|mint)\s*(10|[1-9](?:\.5)?)\b/i);
  if (g) return { grader: "UNKNOWN", grade: g[1] };
  return null;
}

export function isLotOrBundle(title) {
  return /\b(lot|lots|rinkinys|rinkiniai|kolekcija|bundle|\d+\s?vnt|vnt\.|set of \d+|\d+x\b|joblot)\b/i.test(title);
}
