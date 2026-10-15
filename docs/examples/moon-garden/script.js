// At night, moon carrots drink moonlight: a little extra growth each tick.
function onTick(api, dt) {
  const s = api.getStore();
  s.ticks = (s.ticks || 0) + 1;
  api.setStore(s);
  for (const p of api.plants()) {
    if (p.species === 'moon-carrot' && p.health > 0 && api.random() < 0.05) {
      api.mutatePlant(p.x, p.y, { growth: Math.min(1, p.growth + 0.01) });
    }
  }
}

function onEvent(api, event) {
  if (event.kind === 'plant' && event.event === 'ripe' && event.species === 'moon-carrot') {
    api.say('A moon carrot! It hums faintly.');
    api.playSound('twinkle');
  }
}
