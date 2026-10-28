// Forbidden content classes (protocol skill §4; design D6). This change uses a
// deterministic rule set: patterns and structural checks, each class with its
// fixtures in test/content-rules.test.ts. The detection method stays OPEN in
// the skill; a model-based classifier would be an M3 proposal. The classes
// and the rejection point (stage `content`) are fixed and do not depend on it.
//
// Rules err on the side of the participant (the one rule): a borderline
// question is refused with a category, and the principal may rephrase.
import * as z from "zod";

export const ForbiddenContentClassSchema = z.enum(["persuasion_disguised", "third_party_personal_data", "labour_disguised"]);
export type ForbiddenContentClass = z.infer<typeof ForbiddenContentClassSchema>;

/** Lower case, straight apostrophes, single spaces. */
function normalise(text: string): string {
  return text.replace(/[‘’ʼ`]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

// ---- persuasion disguised as a question (push-polls, leading questions) ----

const STANCE_VERBS = "(?:support|vote|trust|buy|recommend|choose|back|hire|use|elect|believe)";
const PERSUASION: RegExp[] = [
  // "Would you still vote for X if you knew …", "less likely to buy … if you learned …"
  new RegExp(`\\b(?:would you (?:still )?|(?:more|less) likely to )(?:\\w+ ){0,3}${STANCE_VERBS}\\b.*\\bif you (?:knew|learned|found out|were told|heard|discovered)\\b`),
  // Tag questions that assert a claim: "wouldn't you agree", "don't you think", "isn't it true that"
  /\b(?:wouldn't|don't|doesn't|won't|shouldn't|can't) you (?:agree|think|say|admit|feel)\b/,
  /\b(?:isn't|wasn't|aren't) it (?:true|obvious|clear|a fact) that\b/,
  /\b(?:everyone|everybody|most people) (?:knows|agrees|can see) that\b/,
  // An accusation smuggled in as a premise: "given that the minister is corrupt, …"
  /\b(?:given|considering|knowing) that\b.*\b(?:corrupt|liars?|lied|criminals?|fraud|scandal|disgrace|incompetent|dangerous|waste)\b/,
];

// ---- personal data about a third party --------------------------------------

/** Identifiers that are never generic: asking for them about anyone else is always out. */
const CONTACT_DATA =
  "(?:home address|(?:postal |street )?address|phone number|mobile number|email address|e-mail address|date of birth|birthday|social security number|national insurance number|passport number|bank account|bank details|credit card|password|login)";
/** Sensitive attributes: out when the question points at a specific other person. */
const SENSITIVE_DATA =
  `(?:${CONTACT_DATA}|salary|income|earns?|medical (?:history|condition|record)s?|diagnosis|health condition|illness|disease|pregnan(?:t|cy)|religion|religious (?:beliefs?|views?)|sexual orientation|political (?:views?|opinions?)|votes? for|criminal record|immigration status|where (?:he|she|they) lives?)`;
/** Singular on purpose: "your patients" asks about a group in aggregate, "your patient" about one person. */
const RELATIONS =
  "(?:neighbou?r|colleague|co-?worker|boss|manager|employee|friend|wife|husband|partner|ex|mother|father|mum|mom|dad|parent|sister|brother|sibling|son|daughter|child|kid|tenant|landlord|client|customer|patient|student|pupil|teacher|doctor|member)";
/** A specific other person: a relation of the participant's, a named person, or an explicit stranger. */
const SPECIFIC_OTHER_PERSON: RegExp[] = [
  new RegExp(`\\b(?:your|my|our|his|her|their) ${RELATIONS}\\b`),
  /\b(?:this|that|a specific|some) (?:person|man|woman|individual)\b/,
  /\bsomeone else\b/,
];
/** Named persons, detected on the original casing: "Jean Martin's", "colleague Anna", "does Anna have". */
const NAMED_PERSON: RegExp[] = [
  /\b[A-Z][a-z]+ [A-Z][a-z]+'s\b/,
  /\b[A-Z][a-z]+'s (?:[a-z]+ )?(?:address|phone|number|email|salary|income|diagnosis|religion|birthday|password|bank|account|record)\b/,
  /\b(?:does|is|did|has|was) [A-Z][a-z]+ (?:have|has|suffer|take|earn|live|believe|vote|pregnant|ill|sick)\b/,
];
/** Pronouns point at another person only next to identifiers that are never generic. */
const PRONOUN_CONTACT = new RegExp(`\\b(?:his|her|their)\\b.*\\b${CONTACT_DATA}\\b|\\b${CONTACT_DATA}\\b.*\\b(?:of|for) (?:him|her|them)\\b`);

// ---- labour disguised as a question ------------------------------------------

const WORK_VERBS =
  "(?:write|draft|translate|design|build|code|program|create|produce|compile|transcribe|summari[sz]e|proofread|rewrite|research|label|annotate|tag|fill (?:in|out)|prepare|develop|implement|make|collect|gather|scrape|generate)";
const IMPERATIVE_LEAD =
  "(?:^|[.!?;:] |\\b(?:please|kindly|can you|could you|would you|will you|i need you to|we need you to|i want you to|we want you to|i'd like you to|you should) )";
const DELIVERABLE =
  "(?:report|essay|article|blog post|post|document|copy|code|script|program|app|application|website|landing page|logo|mock-?up|spreadsheet|list|database|presentation|deck|slides|translation|business plan|plan|proposal|emails?|letters?|summary|transcripts?|interviews?|survey|dataset|images?|photos?|videos?|captions?|(?:product )?descriptions?|pages?|listings?|words?)";
const LABOUR: RegExp[] = [
  new RegExp(`${IMPERATIVE_LEAD}${WORK_VERBS}\\b.*\\b${DELIVERABLE}\\b`),
  // A volume of units of work: "500 images", "30 pages", "2,000-word"
  new RegExp(`${IMPERATIVE_LEAD}${WORK_VERBS}\\b.*\\b\\d[\\d,]*[- ]?(?:words?|pages?|items?|images?|photos?|rows?|entries|products?|listings?|records?|leads?|emails?|reviews?|tasks?)\\b`),
];

/**
 * The first forbidden content class the text falls into, or null. Checks run
 * in a fixed order: persuasion, third-party personal data, labour.
 */
export function classifyForbiddenContent(text: string): ForbiddenContentClass | null {
  const t = normalise(text);
  if (PERSUASION.some((r) => r.test(t))) return "persuasion_disguised";

  const original = text.replace(/[‘’ʼ`]/g, "'");
  const sensitive = new RegExp(`\\b${SENSITIVE_DATA}\\b`).test(t);
  const specific = SPECIFIC_OTHER_PERSON.some((r) => r.test(t)) || NAMED_PERSON.some((r) => r.test(original));
  if ((sensitive && specific) || PRONOUN_CONTACT.test(t)) return "third_party_personal_data";

  if (LABOUR.some((r) => r.test(t))) return "labour_disguised";
  return null;
}
