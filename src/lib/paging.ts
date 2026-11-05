// One page per history generation. Late responses cannot unlock or update a newer view.
export function createPageGate() {
  let generation = 0;
  let active = false;
  return {
    invalidate() {
      active = false;
      return ++generation;
    },
    begin() {
      if (active) return null;
      active = true;
      return generation;
    },
    isCurrent(token: number) {
      return token === generation;
    },
    finish(token: number) {
      if (token !== generation) return false;
      active = false;
      return true;
    },
  };
}
