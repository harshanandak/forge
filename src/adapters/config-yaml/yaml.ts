// The one place the package `yaml` is imported. The build replaces this file's output with a
// single bundle of yaml (tools/bundle-yaml.ts): its 70-odd module files cost more to load than the
// parsing costs, and every command reads the project config.
export { isMap, isNode, isScalar, parseDocument, stringify } from "yaml";
