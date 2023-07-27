/**
 * subprocess_simple.ts
 */

// define command used to create the subprocess

export const denoDoc = async (
  path: string,
  importMap: string,
  replacer: (str: string) => string,
): Promise<string> => {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "doc",
      "--import-map",
      importMap,
      "--json",
      path,
    ],
  });

  // create subprocess and collect output
  const { code, stdout, stderr } = await command.output();
  if (code > 0) {
    console.log(new TextDecoder().decode(stderr));
    return "[]";
  }

  return replacer(new TextDecoder().decode(stdout));
};
