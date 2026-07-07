export type RevisionSubmitQueue = {
  enqueue<T>(targetKey: string, task: () => Promise<T>): Promise<T>;
};

export function createRevisionSubmitQueue(): RevisionSubmitQueue {
  const pendingByTarget = new Map<string, Promise<unknown>>();

  return {
    enqueue(targetKey, task) {
      const previous = pendingByTarget.get(targetKey) ?? Promise.resolve();
      const run = previous.then(task, task);

      pendingByTarget.set(
        targetKey,
        run.finally(() => {
          if (pendingByTarget.get(targetKey) === run) {
            pendingByTarget.delete(targetKey);
          }
        }),
      );

      return run;
    },
  };
}
