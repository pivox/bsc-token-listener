export function tolerateMissingFile<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
