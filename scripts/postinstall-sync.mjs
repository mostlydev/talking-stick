import { updateInstructions } from "../dist/instructions.js";
import { syncInstalledSkills } from "../dist/skill-install.js";

syncInstalledSkills({
  skipMissing: true,
  markOffers: false,
  env: process.env,
  homeDir: process.env.HOME
});

updateInstructions({
  markOffers: false,
  options: {
    env: process.env,
    homeDir: process.env.HOME
  }
});
