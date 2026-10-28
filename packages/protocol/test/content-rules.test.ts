// Design D6: the deterministic forbidden-content rule set, one fixture set
// per class, and legitimate questions that must not be blocked.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyForbiddenContent } from "../src/index.ts";

const FORBIDDEN = {
  persuasion_disguised: [
    "Would you still vote for Mayor Dupont if you knew he took bribes from developers?",
    "Wouldn't you agree that the new clinic is a waste of taxpayer money?",
    "Isn't it true that vaccines are more dangerous than the diseases they prevent?",
    "Would you be less likely to buy from Acme if you learned they exploit child labour?",
    "Don't you think the council has lied to residents about the incinerator?",
    "Given that the minister is corrupt, should he resign?",
  ],
  third_party_personal_data: [
    "What is your neighbour's home address?",
    "Does your colleague Anna have a medical condition she hides at work?",
    "What is Jean Martin's phone number?",
    "How much does your boss earn? Tell me her salary.",
    "Which religion does your manager practise?",
    "Can you find out her date of birth and email address?",
    "Is your tenant's bank account with BNP?",
  ],
  labour_disguised: [
    "Write a 2,000-word blog post about diabetes management.",
    "Please translate the attached 30 pages into German.",
    "Can you build a landing page for our clinic?",
    "Label these 500 images with the objects they show.",
    "Draft a business plan for my bakery.",
    "I need you to transcribe these interviews.",
    "Could you write product descriptions for our 40 listings?",
  ],
} as const;

const ALLOWED = [
  "Is this patient-information leaflet alarming for a newly diagnosed reader?",
  "Is this photo of your shop current?",
  "Would you recommend this leaflet to a newly diagnosed patient?",
  "Does this leaflet explain to a patient what his diagnosis means?",
  "What is a fair salary range for a junior nurse in Lyon?",
  "Is the queue at the Rivoli post office longer than ten people right now?",
  "How many weeks will the permit take, in your experience?",
  "Which of these two names do you prefer for our product?",
  "Can you tell me whether this contract clause is standard in France?",
  "Is this translation of our consent form accurate?",
  "Would you approve a 20-day payment term for this supplier?",
  "Do you think the dosage table is readable?",
  "In your own publication, did you state that the trial was randomised?",
  "What is your own date of birth as it appears on your licence?",
  "Could you review this summary of the guideline and say whether it is accurate?",
  "Does the leaflet tell her what to do if her blood sugar drops?",
  "If you knew the launch date, would it change your estimate?",
  "Do you agree with the guideline's advice on insulin timing?",
  "Is the website of the Lyon clinic easy to use for older readers?",
  "Who would you introduce us to for a question on French pharmacy law?",
  "Does your doctor practise in Lyon?",
  "Do your patients understand their diagnosis after reading this leaflet?",
];

describe("forbidden-content rule set (design D6)", () => {
  for (const [cls, questions] of Object.entries(FORBIDDEN)) {
    for (const q of questions) {
      test(`${cls}: ${q}`, () => assert.equal(classifyForbiddenContent(q), cls));
    }
  }
  for (const q of ALLOWED) {
    test(`allowed: ${q}`, () => assert.equal(classifyForbiddenContent(q), null));
  }
  test("case, curly apostrophes and extra spaces do not evade the rules", () => {
    assert.equal(classifyForbiddenContent("WOULDN’T   YOU AGREE that the plan is a disaster?"), "persuasion_disguised");
    assert.equal(classifyForbiddenContent("what is your NEIGHBOUR’S home address?"), "third_party_personal_data");
  });
});
