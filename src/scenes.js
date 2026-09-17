/* Shared scene registry.
 *
 * Same idea as characters.js: loaded into both the content script's isolated
 * world and the popup page, so the engine and the dropdown can never disagree
 * about which scenes exist. Adding a scene is one line here plus the .glb.
 *
 * Per entry:
 *   key          registry id; also the filename stem (assets/scenes/<key>.glb)
 *   name         label shown in the popup dropdown
 *   floorInsetX  fraction of the model's X footprint the pets may walk on
 *   floorInsetZ  ditto for Z. The model's bounding box includes walls and
 *                furniture, so the walkable floor is inset from it.
 *   elevationDeg how far above the floor plane the camera sits. Higher shows
 *                more floor to walk on but flattens the scene.
 *   stageAspect  canvas height as a fraction of its width; roughly follow the
 *                model's own footprint so it is not framed in dead space.
 */

(() => {
  "use strict";
  if (window.PKMN_SCENES) return;

  const DIR = "assets/scenes";

  const LIST = [
    {
      key: "pokemon-center",
      name: "Pokémon Center",
      // A wide, shallow room: 2.44 x 1.26 footprint.
      floorInsetX: 0.78,
      floorInsetZ: 0.62,
      elevationDeg: 26,
      stageAspect: 0.58,
    },
  ];

  const SCENES = {};
  for (const s of LIST) SCENES[s.key] = { ...s, file: `${DIR}/${s.key}.glb` };

  window.PKMN_SCENES = SCENES;
  window.PKMN_SCENE_KEYS = LIST.map((s) => s.key);
})();
