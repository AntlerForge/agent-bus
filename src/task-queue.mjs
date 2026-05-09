export function createQueue({ log = () => {} } = {}) {
  const queue = [];
  const waiters = [];
  let draining = false;
  let promptRefresh = () => {};

  async function drain() {
    if (draining) {
      return;
    }

    draining = true;
    try {
      while (queue.length) {
        const item = queue.shift();
        try {
          await item.run();
        } catch (error) {
          log(`Queued task failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      draining = false;
      while (waiters.length) {
        waiters.shift()();
      }
      promptRefresh();
    }
  }

  return {
    enqueue(run) {
      queue.push({ run });
      void drain();
    },
    waitForIdle() {
      if (!draining && queue.length === 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    setPromptRefresh(refresh) {
      promptRefresh = refresh;
    },
    isIdle() {
      return !draining && queue.length === 0;
    },
  };
}
