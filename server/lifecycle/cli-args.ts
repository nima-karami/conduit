export function argValue(args: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) {
      const value = args[i + 1];
      return value && !value.startsWith('--') ? value : undefined;
    }
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1) || undefined;
  }
  return undefined;
}

export function requireUserData(args: readonly string[]): string {
  const userData = argValue(args, '--user-data');
  if (!userData) throw new Error('Missing required --user-data argument');
  return userData;
}
