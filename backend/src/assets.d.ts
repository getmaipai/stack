// A `with { type: "file" }` import resolves to the file's path at run
// time (and to an embedded copy in a compiled binary); Bun's types do
// not declare the module shape per extension.
declare module "*.wav" {
  const path: string;
  export default path;
}

declare module "*.txt" {
  const path: string;
  export default path;
}
