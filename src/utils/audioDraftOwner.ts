type Release = () => Promise<void>;
/** The concrete in-memory file owner holds protection until upload acceptance or discard.
 * Recording passes its existing lease synchronously, without an unprotected gap. */
export function createAudioDraftOwner(acquire: () => Promise<Release>) {
  const drafts = new Map<string, {file: unknown; lease: Promise<Release>}>();
  let disposed = false;
  const release = async (entry: {lease: Promise<Release>}) => (await entry.lease)();
  return {
    async retain(slot: string, file: unknown, transferred?: Release) {
      const old = drafts.get(slot);
      if (!file) { drafts.delete(slot); if (old) await release(old); return; }
      const entry = {file,lease:transferred ? Promise.resolve(transferred) : acquire()};
      if (disposed) { await release(entry); return; }
      drafts.set(slot,entry);
      try { await entry.lease; } catch (error) { if (drafts.get(slot) === entry) { if (old) drafts.set(slot, old); else drafts.delete(slot); } throw error; }
      if (old) await release(old);
    },
    async upload<T>(file: unknown, operation: () => Promise<T>) {
      const owned = [...drafts.entries()].filter(([,entry]) => entry.file === file);
      const result = await operation(); // rejection keeps the draft protected
      for (const [slot,entry] of owned) if (drafts.get(slot) === entry) { drafts.delete(slot); await release(entry); }
      return result;
    },
    async dispose() { disposed = true; const entries = [...drafts.values()]; drafts.clear(); await Promise.all(entries.map(release)); },
  };
}
