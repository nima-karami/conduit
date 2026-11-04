export default function checkRuntime(context: {
  electronPlatformName: string;
  arch: number;
  packager: { projectDir: string };
}): Promise<void>;
