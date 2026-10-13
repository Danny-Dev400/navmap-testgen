import { nanoid } from "nanoid";

// Prints a fresh run id for a /navmap batch — a script so the skill doesn't need `node -e`
// (which would mean allowing arbitrary inline code in headless runs).
console.log(nanoid());
