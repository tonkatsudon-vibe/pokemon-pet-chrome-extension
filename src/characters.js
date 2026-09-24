/* Shared character registry.
 *
 * Loaded into BOTH the content script's isolated world and the popup page, so
 * the engine and the settings UI can never disagree about who exists. Adding a
 * Pokémon is one line here plus the two asset files — nothing else needs to
 * change, because the checkbox list and the file paths are both derived from
 * this table.
 *
 * A content script cannot list its own extension folder at runtime, so the
 * roster has to be declared rather than discovered. Keeping it in one place is
 * the next best thing.
 *
 * Per entry:
 *   key        registry id; also the asset filename stem
 *   name       label shown in the popup
 *   size       on-screen box in px (sprites are letterboxed into it)
 *   faces      direction the raw art looks; the engine flips it to match travel
 *   baseSpeed  px/second at speed slider 5
 *   noMp3      optional; set when no recorded cry ships for this character.
 *              They are not silent — the engine synthesizes a stand-in cry.
 *   evolvesTo  optional; key of the next form. Double-clicking a pet that has
 *              one plays the evolution flash and turns it into that character.
 */

(() => {
  "use strict";
  if (window.PKMN_CHARACTERS) return;

  const ICON_DIR = "assets/icons/pokemon/icons";
  const SOUND_DIR = "assets/icons/pokemon/sounds";

  const ROSTER = [
    // The Charmander line. Each form points at the next; Charizard is the end of it.
    { key: "charmander", name: "Charmander",    size:  76, faces: "left",  baseSpeed: 44, noMp3: true, evolvesTo: "charmeleon" },
    { key: "charmeleon", name: "Charmeleon",    size:  90, faces: "left",  baseSpeed: 50, noMp3: true, evolvesTo: "charizard" },
    { key: "charizard",name: "Charizard",      size: 104, faces: "left",  baseSpeed: 58 },
    // The Gastly line. Each form points at the next; Gengar is the end of it.
    { key: "gastly",    name: "Gastly",         size:  80, faces: "left",  baseSpeed: 40, noMp3: true, evolvesTo: "haunter" },
    { key: "haunter",   name: "Haunter",        size:  92, faces: "left",  baseSpeed: 48, noMp3: true, evolvesTo: "gengar" },
    { key: "gengar",    name: "Gengar", size:  96, faces: "left",  baseSpeed: 46 },
    { key: "sylveon",   name: "Sylveon",        size:  84, faces: "left",  baseSpeed: 52 },
    { key: "mewtwo",    name: "Mewtwo",         size: 100, faces: "right", baseSpeed: 40 },
    // Drawn curled up asleep and facing right — big, wide and in no hurry.
    { key: "snorlax",   name: "Snorlax",        size: 112, faces: "right", baseSpeed: 30 },
    // No mp3 for these two yet, so they get a synthesized cry.
    { key: "venusaur",  name: "Venusaur",       size: 106, faces: "left",  baseSpeed: 36, noMp3: true },
    { key: "blastoise", name: "Blastoise",      size: 104, faces: "left",  baseSpeed: 40, noMp3: true },
  ];

  const CHARACTERS = {};
  for (const c of ROSTER) {
    CHARACTERS[c.key] = {
      name: c.name,
      size: c.size,
      faces: c.faces,
      baseSpeed: c.baseSpeed,
      // null means "final form" — the engine hides the evolve interaction.
      evolvesTo: c.evolvesTo || null,
      file: `${ICON_DIR}/${c.key}.gif`,
      // null means "no recording"; Cries falls back to a synthesized cry.
      cry: c.noMp3 ? null : `${SOUND_DIR}/${c.key}.mp3`,
    };
  }

  window.PKMN_CHARACTERS = CHARACTERS;
  window.PKMN_CHARACTER_KEYS = ROSTER.map((c) => c.key);
})();
