import type { ActionEdge, PageNode } from "./navmap-types.js";
import type { UiComponent } from "./navmapUiComponents.js";
import { locatorFingerprint } from "./navmapComponents.js";
import { locatorExpr, scopedLocatorExpr, urlMatchRegexLiteral, withPageRef } from "./navmap-playwright-gen.js";

function jsStringLiteral(value: string): string {
  return JSON.stringify(value);
}

// Caps generated identifiers to a readable length — edge.target in particular is sometimes a
// full descriptive sentence (e.g. "Footer social link (X / Facebook / LinkedIn) — opens in a
// new tab..."), which would otherwise produce an unusably long field name.
const MAX_IDENTIFIER_WORDS = 6;

const TRAILING_STOPWORDS = new Set(["a", "an", "the", "on", "in", "of", "for", "with", "to", "by"]);

function words(text: string): string[] {
  const w = text
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_IDENTIFIER_WORDS);
  // Truncation can leave a dangling preposition/article right at the cut point (e.g. "...button
  // on a") — trim those so the identifier ends on a real word, not mid-phrase.
  while (w.length > 1 && TRAILING_STOPWORDS.has(w[w.length - 1].toLowerCase())) w.pop();
  return w;
}

export function toCamelCase(text: string, fallback = "value"): string {
  const w = words(text);
  if (w.length === 0) return fallback;
  return w
    .map((word, i) => (i === 0 ? word.toLowerCase() : word[0].toUpperCase() + word.slice(1).toLowerCase()))
    .join("");
}

export function toPascalCase(text: string, fallback = "Unknown"): string {
  const camel = toCamelCase(text, fallback);
  return camel[0].toUpperCase() + camel.slice(1);
}

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

export function pageClassName(page: PageNode): string {
  const base = toPascalCase(page.title || page.urlPattern);
  return base.endsWith("Page") ? base : `${base}Page`;
}

export function componentClassName(regionName: string): string {
  const base = toPascalCase(regionName, "Shared");
  return base.endsWith("Component") ? base : `${base}Component`;
}

export function componentFieldName(regionName: string): string {
  return toCamelCase(regionName, "component");
}

export function methodName(semanticIntent: string): string {
  return toCamelCase(semanticIntent, "performAction");
}

export function instanceVarName(className: string): string {
  return lowerFirst(className);
}

/** Dedupes repeated requests for the same free-text-derived identifier within one class (e.g.
 *  two edges whose target text produces the same field name) by appending a numeric suffix —
 *  never silently drops/overwrites a field or method, since that would lose a real locator. */
export class NameAllocator {
  private used = new Set<string>();
  take(preferred: string): string {
    if (!this.used.has(preferred)) {
      this.used.add(preferred);
      return preferred;
    }
    let i = 2;
    while (this.used.has(`${preferred}${i}`)) i++;
    const name = `${preferred}${i}`;
    this.used.add(name);
    return name;
  }
}

type ArgStyle = "none" | "value" | "key" | "login";

interface MethodBody {
  params: string;
  bodyLine: string;
  argStyle: ArgStyle;
  formKeys?: FormKey[];
}

/** One recorded form input as a key of the method's `form` parameter. */
export interface FormKey {
  label: string;
  key: string;
  value: string;
}

/** Same verb-sniffing heuristic used throughout this generator (actionStatement in
 *  navmap-test-generator.ts, actionIcon in app/src/testCaseIcons.ts) — kept consistent by hand
 *  across the three since each needs a slightly different output shape (inline statement /
 *  display icon / method body). */
function actionMethodBody(action: string, inputValue: string | undefined, fieldName: string): MethodBody {
  const a = action.toLowerCase();
  const target = `this.${fieldName}`;
  if (a.includes("fill") || a.includes("type") || a.includes("enter")) {
    return { params: "value: string", bodyLine: `await ${target}.fill(value);`, argStyle: "value" };
  }
  if (a.includes("select")) {
    return { params: "value: string", bodyLine: `await ${target}.selectOption(value);`, argStyle: "value" };
  }
  if (a.includes("check")) {
    return { params: "", bodyLine: `await ${target}.check();`, argStyle: "none" };
  }
  if (a.includes("hover")) {
    return { params: "", bodyLine: `await ${target}.hover();`, argStyle: "none" };
  }
  if (a.includes("press")) {
    return {
      params: `key: string = ${jsStringLiteral(inputValue || "Enter")}`,
      bodyLine: `await ${target}.press(key);`,
      argStyle: "key",
    };
  }
  return { params: "", bodyLine: `await ${target}.click();`, argStyle: "none" };
}

/** Prepends the edge's recorded form inputs to a method body: one locator field per input
 *  (registered through addField) and a trailing `form` parameter whose defaults are the recorded
 *  test values — so existing no-argument call sites still submit a filled form, and a test can
 *  pass other data. */
function withFormFill(edge: ActionEdge | undefined, body: MethodBody, addField: (locatorCode: string, hint: string) => string): MethodBody {
  if (!edge?.formFields?.length) return body;
  const keys = new NameAllocator();
  const entries = edge.formFields.map((f) => ({ ...f, key: keys.take(toCamelCase(f.label, "field")), field: addField(locatorExpr(f.locator), `${f.label} input`) }));
  const defaults = entries.map((e) => `${e.key}: ${jsStringLiteral(e.value)}`).join(", ");
  const fills = entries.map((e) => {
    const verb = e.action === "select" ? "selectOption" : e.action === "check" ? "check" : "fill";
    return verb === "check" ? `await this.${e.field}.check();` : `await this.${e.field}.${verb}(form.${e.key});`;
  });
  return {
    ...body,
    params: [body.params, `form = { ${defaults} }`].filter(Boolean).join(", "),
    bodyLine: [...fills, body.bodyLine].join("\n    "),
    formKeys: entries.map((e) => ({ label: e.label, key: e.key, value: e.value })),
  };
}

/** How a generated test should call through to this edge's action/assertion target, relative to
 *  a page-object instance variable the test itself names (e.g. "inventoryPage") — never
 *  including that variable, since callers prefix it. methodPath/locatorPath may be dotted
 *  (e.g. "navbar.logOut" / "navbar.logoutLink") when the edge belongs to a composed component. */
export interface EdgeCallInfo {
  methodPath: string;
  locatorPath: string;
  argStyle: ArgStyle;
  /** Keys of the method's trailing `form` parameter (after the value/key argument), if any. */
  formKeys?: FormKey[];
  /** Set for list-item actions: the method's last parameter is the item, and this getter (path
   *  relative to the page variable) builds the item's locator. */
  item?: { getterPath: string; recorded: string };
}

export interface GeneratedClass {
  className: string;
  fileName: string;
  source: string;
}

export interface GeneratedComponentClass extends GeneratedClass {
  /** Relative to the component instance itself (no page/component-field prefix). */
  elementCallInfo: Map<string, EdgeCallInfo>;
}

export interface GeneratedPageClass extends GeneratedClass {
  /** Relative to a page-object instance variable the test names itself. */
  edgeCallInfo: Map<string, EdgeCallInfo>;
  /** PageNode.elements by id: a locator field, or (one per list item) a getter taking the item. */
  elementInfo: Map<string, { field?: string; getter?: string; recordedItem?: string }>;
}

/** One class per UiComponent — a structural region (navbar, footer, ...) reused across 2+
 *  pages. Composed by every page that touches it (see buildPageClass) instead of duplicating
 *  its locators/methods on each one. */
export function buildComponentClass(component: UiComponent): GeneratedComponentClass {
  const className = componentClassName(component.regionName);
  // One namespace for fields and methods — in a TS class they collide with each other too.
  const names = new NameAllocator();
  names.take("page");

  const fields: { fieldName: string; locatorCode: string }[] = [];
  const methods: { methodName: string; fieldName: string; params: string; bodyLine: string; comment: string }[] = [];
  const elementCallInfo = new Map<string, EdgeCallInfo>();

  for (const element of component.elements) {
    const sampleEdge = element.memberEdges[0];
    const fieldName = names.take(toCamelCase(sampleEdge.target || element.label, "element"));
    fields.push({ fieldName, locatorCode: locatorExpr(element.locator) });
    const addField = (locatorCode: string, hint: string) => {
      const existing = fields.find((f) => f.locatorCode === locatorCode);
      if (existing) return existing.fieldName;
      const name = names.take(toCamelCase(hint, "field"));
      fields.push({ fieldName: name, locatorCode });
      return name;
    };
    const formEdge = element.memberEdges.find((e) => e.formFields?.length);
    const { params, bodyLine, argStyle, formKeys } = withFormFill(formEdge, actionMethodBody(sampleEdge.action, sampleEdge.inputValue, fieldName), addField);
    const mName = names.take(methodName(element.label));
    methods.push({ methodName: mName, fieldName, params, bodyLine, comment: sampleEdge.target });
    for (const edge of element.memberEdges) {
      elementCallInfo.set(edge.id, { methodPath: mName, locatorPath: fieldName, argStyle, formKeys });
    }
  }

  const fieldLines = fields.map((f) => `  readonly ${f.fieldName}: Locator;`).join("\n");
  const ctorLines = fields.map((f) => `    this.${f.fieldName} = ${f.locatorCode};`).join("\n");
  const methodBlocks = methods
    .map(
      (m) => `  async ${m.methodName}(${m.params}) {
    ${m.bodyLine} // ${m.comment}
  }`,
    )
    .join("\n\n");

  const source = `// Generated POM component — do not hand-edit, regenerate instead.
import type { Page, Locator } from "@playwright/test";

export class ${className} {
  readonly page: Page;

${fieldLines}

  constructor(page: Page) {
    this.page = page;
${ctorLines}
  }

${methodBlocks}
}
`;

  return { className, fileName: `${className}.ts`, source, elementCallInfo };
}

/** One class per PageNode with outgoing edges. Section order matches the user's own sketch:
 *  composed components, then locators, then the constructor, then action methods. Edges that
 *  belong to a UiComponent get no method here at all — only on the component class, reached via
 *  the composed field (e.g. `inventoryPage.navbar.logOut()`) — their entry in edgeCallInfo has
 *  the component field name already prefixed (looked up from generatedComponents). Locator
 *  fields are deduped by locator fingerprint (not by edge) — two edges that click the very same
 *  element (e.g. a login button used by both a happy-path and a validation-error edge) share one
 *  field, each still getting its own distinctly-named method. */
export function buildPageClass(
  page: PageNode,
  className: string,
  edges: ActionEdge[],
  gotoUrl: string,
  edgeIdToComponent: Map<string, UiComponent>,
  generatedComponents: Map<string, GeneratedComponentClass>,
  componentImportPath: (component: UiComponent) => string,
  /** Components a setup chain needs to drive on this page even though none of this page's own
   *  recorded edges touch them (e.g. opening the header menu on a page where it was never clicked). */
  extraComponents: UiComponent[] = [],
): GeneratedPageClass {
  // One namespace for component fields, locator fields and methods — in a TS class they all
  // collide with each other, so two edges with the same intent can't produce uncompilable code.
  const names = new NameAllocator();
  names.take("page");
  names.take("goto");
  const edgeCallInfo = new Map<string, EdgeCallInfo>();

  const componentEdges = edges.filter((e) => edgeIdToComponent.has(e.id));
  const ownEdges = edges.filter((e) => !edgeIdToComponent.has(e.id));

  const usedComponents = new Map<string, UiComponent>();
  for (const edge of componentEdges) {
    const component = edgeIdToComponent.get(edge.id)!;
    usedComponents.set(component.id, component);
  }
  for (const component of extraComponents) usedComponents.set(component.id, component);

  const componentImports: string[] = [];
  const componentFields: { fieldName: string; className: string }[] = [];
  for (const component of usedComponents.values()) {
    const compClassName = componentClassName(component.regionName);
    const fieldName = names.take(componentFieldName(component.regionName));
    componentImports.push(`import { ${compClassName} } from "${componentImportPath(component)}";`);
    componentFields.push({ fieldName, className: compClassName });

    const generated = generatedComponents.get(component.id);
    if (generated) {
      for (const edge of component.elements.flatMap((el) => el.memberEdges)) {
        const info = generated.elementCallInfo.get(edge.id);
        if (!info) continue;
        edgeCallInfo.set(edge.id, {
          methodPath: `${fieldName}.${info.methodPath}`,
          locatorPath: `${fieldName}.${info.locatorPath}`,
          argStyle: info.argStyle,
          formKeys: info.formKeys,
        });
      }
    }
  }

  const fieldByFingerprint = new Map<string, string>();
  const locatorFields: { fieldName: string; locatorCode: string }[] = [];
  function fieldFor(edge: ActionEdge): string {
    const fp = locatorFingerprint(edge.locator);
    const existing = fieldByFingerprint.get(fp);
    if (existing) return existing;
    const fieldName = names.take(toCamelCase(edge.target || edge.semanticIntent, "element"));
    fieldByFingerprint.set(fp, fieldName);
    locatorFields.push({ fieldName, locatorCode: locatorExpr(edge.locator) });
    return fieldName;
  }
  // Form inputs (withFormFill) share fields with any edge that already targets the same element.
  function addPageField(locatorCode: string, hint: string): string {
    const existing = locatorFields.find((f) => f.locatorCode === locatorCode);
    if (existing) return existing.fieldName;
    const fieldName = names.take(toCamelCase(hint, "field"));
    locatorFields.push({ fieldName, locatorCode });
    return fieldName;
  }

  // goto() also proves arrival: a redirect (an expired session bounced to login, a page that needs
  // prior state) fails right here with a clear message instead of as a confusing "element not
  // found" several steps later.
  const arrivalLines = [`    await expect(this.page, ${jsStringLiteral(`expected to arrive on "${page.title}"`)}).toHaveURL(${urlMatchRegexLiteral(new URL(gotoUrl).origin, page.urlPattern)});`];
  if (page.anchor) {
    arrivalLines.push(`    await expect(${withPageRef(locatorExpr(page.anchor), "this.page")}, ${jsStringLiteral(`"${page.title}" landmark`)}).toBeVisible();`);
  }
  const methodBlocks: string[] = [
    `  async goto() {
    await this.page.goto(${jsStringLiteral(gotoUrl)});
${arrivalLines.join("\n")}
  }`,
  ];
  for (const edge of ownEdges) {
    if (edge.scope) {
      // Repeated element (one per list item): a locator method taking the item text, defaulting to
      // the item it was recorded on, plus the action method with the same trailing parameter — so
      // call sites that pass nothing keep acting on the recorded item.
      const itemDefault = jsStringLiteral(edge.scope.hasText);
      const getter = names.take(`${toCamelCase(edge.target || edge.semanticIntent, "element")}For`);
      methodBlocks.push(`  ${getter}(item = ${itemDefault}): Locator {
    return ${scopedLocatorExpr(edge.scope, edge.locator, "item", "this.page")};
  }`);
      const { params, bodyLine, argStyle, formKeys } = withFormFill(edge, actionMethodBody(edge.action, edge.inputValue, `${getter}(item)`), addPageField);
      const mName = names.take(methodName(edge.semanticIntent));
      methodBlocks.push(`  async ${mName}(${[params, `item = ${itemDefault}`].filter(Boolean).join(", ")}) {
    ${bodyLine} // ${edge.target}
  }`);
      edgeCallInfo.set(edge.id, { methodPath: mName, locatorPath: `${getter}()`, argStyle, formKeys, item: { getterPath: getter, recorded: edge.scope.hasText } });
      continue;
    }
    if (edge.authFormLocators) {
      const usernameField = names.take("usernameInput");
      const passwordField = names.take("passwordInput");
      const submitField = fieldFor(edge);
      const loginMethod = names.take("login");
      locatorFields.push({ fieldName: usernameField, locatorCode: locatorExpr(edge.authFormLocators.username) });
      locatorFields.push({ fieldName: passwordField, locatorCode: locatorExpr(edge.authFormLocators.password) });
      methodBlocks.push(`  async ${loginMethod}(username: string, password: string) {
    await this.${usernameField}.fill(username);
    await this.${passwordField}.fill(password);
    await this.${submitField}.click();
  }`);
      edgeCallInfo.set(edge.id, { methodPath: loginMethod, locatorPath: submitField, argStyle: "login" });
      continue;
    }

    const fieldName = fieldFor(edge);
    const { params, bodyLine, argStyle, formKeys } = withFormFill(edge, actionMethodBody(edge.action, edge.inputValue, fieldName), addPageField);
    const mName = names.take(methodName(edge.semanticIntent));
    methodBlocks.push(`  async ${mName}(${params}) {
    ${bodyLine} // ${edge.target}
  }`);
    edgeCallInfo.set(edge.id, { methodPath: mName, locatorPath: fieldName, argStyle, formKeys });
  }

  // Readable elements (prices, totals, status text) — reused by any test case that captures or checks them.
  const elementInfo: GeneratedPageClass["elementInfo"] = new Map();
  for (const el of page.elements ?? []) {
    if (el.scope) {
      const itemDefault = jsStringLiteral(el.scope.hasText);
      const getter = names.take(`${toCamelCase(el.label, "element")}For`);
      methodBlocks.push(`  ${getter}(item = ${itemDefault}): Locator {
    return ${scopedLocatorExpr(el.scope, el.locator, "item", "this.page")}; // ${el.label}
  }`);
      elementInfo.set(el.id, { getter, recordedItem: el.scope.hasText });
    } else {
      const field = addPageField(locatorExpr(el.locator), el.label);
      elementInfo.set(el.id, { field });
    }
  }

  const importsBlock = componentImports.length > 0 ? `${componentImports.join("\n")}\n` : "";
  const componentsSection =
    componentFields.length > 0
      ? `\n  // Components\n${componentFields.map((c) => `  readonly ${c.fieldName}: ${c.className};`).join("\n")}\n`
      : "";
  const locatorsSection =
    locatorFields.length > 0
      ? `\n  // Locators\n${locatorFields.map((f) => `  readonly ${f.fieldName}: Locator;`).join("\n")}\n`
      : "";
  const ctorComponentLines = componentFields.map((c) => `    this.${c.fieldName} = new ${c.className}(page);`).join("\n");
  const ctorLocatorLines = locatorFields.map((f) => `    this.${f.fieldName} = ${f.locatorCode};`).join("\n");
  const ctorBody = [ctorComponentLines, ctorLocatorLines].filter(Boolean).join("\n");

  const source = `// Generated POM page object — do not hand-edit, regenerate instead.
// Page: ${page.title} (${page.urlPattern})
import { expect, type Page, type Locator } from "@playwright/test";
${importsBlock}
export class ${className} {
  readonly page: Page;
${componentsSection}${locatorsSection}
  constructor(page: Page) {
    this.page = page;
${ctorBody}
  }

${methodBlocks.join("\n\n")}
}
`;

  return { className, fileName: `${className}.ts`, source, edgeCallInfo, elementInfo };
}
