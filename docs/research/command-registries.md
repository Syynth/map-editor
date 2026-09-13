# Command registries and extension surfaces in comparable editors

Research for [#5](https://github.com/Syynth/papercut/issues/5), under the map
[#2](https://github.com/Syynth/papercut/issues/2). Feeds three later decisions: the command
dispatch prototype, the feature-module extension surface, and the keymap registry.

Everything above the final section is fact, sourced from primary documentation and source code.
The last section, **What to steal, what to avoid**, is opinion and is marked as such.

A note on the word *command*. In this document it means the map's sense — a named, enumerable,
remappable intent. It does **not** mean `src/core/commands.ts`'s `Command`
(`{ label, patches, inverse }`), which the map is renaming to **Edit**. Where a system uses a
third word for the intent layer — Blender's *operator*, Unity's *shortcut*, Godot's *palette
command* — that word is used.

---

## 1. VS Code

The closest analogue, and the one studied hardest. Two registries, joined only by a string.

### 1.1 The declaration: `contributes.commands`

A command is declared in `package.json`, statically, before any extension code runs.

```json
{
  "contributes": {
    "commands": [
      {
        "command": "extension.sayHello",
        "title": "Hello World",
        "category": "Hello",
        "icon": { "light": "path/to/light/icon.svg", "dark": "path/to/dark/icon.svg" }
      }
    ]
  }
}
```

The authoritative field list is the JSON schema in
[`src/vs/workbench/services/actions/common/menusExtensionPoint.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/actions/common/menusExtensionPoint.ts),
not the docs page (which never mentions `shortTitle`):

```ts
export interface IUserFriendlyCommand {
    command: string;
    title: string | ILocalizedString;
    shortTitle?: string | ILocalizedString;
    enablement?: string;
    category?: string | ILocalizedString;
    icon?: IUserFriendlyIcon;
}
```

Only `command` and `title` are required. What each carries, in the schema's own words:

| Field | Purpose |
|---|---|
| `command` | "Identifier of the command to execute" |
| `title` | "Title by which the command is represented in the UI" |
| `shortTitle` | Compact rendering; "Menus pick either `title` or `shortTitle` depending on the context" |
| `category` | "Category string by which the command is grouped in the UI" — the palette prefixes with it |
| `enablement` | A when-clause. "Condition which must be true to enable the command in the UI (menu and keybindings). **Does not prevent executing the command by other means, like the `executeCommand`-api.**" |
| `icon` | File path, light/dark pair, or a theme icon (`"$(zap)"`) |

The declaration is **pure data**: strings, a condition expression, an icon path. Nothing callable.

At load, each entry becomes a `MenuRegistry` command — note `enablement` becoming `precondition`:

```ts
const { icon, enablement, category, title, shortTitle, command } = userFriendlyCommand;
_commandRegistrations.add(MenuRegistry.addCommand({
    id: command,
    title,
    source: { id: extension.description.identifier.value, title: ... },
    shortTitle,
    tooltip: title,
    category,
    precondition: ContextKeyExpr.deserialize(enablement),
    icon: absoluteIcon
}));
```

### 1.2 The handler, registered separately

> "`vscode.commands.registerCommand` only binds a command ID to a handler function. To expose this
> command in the Command Palette so it is discoverable by users, you also need a corresponding
> command `contribution` in your extension's `package.json`"
> — [Commands guide](https://code.visualstudio.com/api/extension-guides/command)

```ts
export function activate(context: vscode.ExtensionContext) {
  const command = 'myExtension.sayHello';
  const commandHandler = (name: string = 'world') => { console.log(`Hello ${name}!!!`); };
  context.subscriptions.push(vscode.commands.registerCommand(command, commandHandler));
}
```

Two registries, deliberately:

- **Declaration** → `MenuRegistry` ([`src/vs/platform/actions/common/actions.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/actions/common/actions.ts)) — UI identity: title, category, icon, precondition.
- **Handler** → `CommandsRegistry` ([`src/vs/platform/commands/common/commands.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/commands/common/commands.ts)) — executable identity: `{ id, handler, metadata }`.

The two failure modes are both legal states, and the asymmetry is the whole point:

- **Declared, never registered.** Palette entry exists; invoking it activates the extension, waits,
  then rejects: `` new Error(`command '${id}' not found`) `` in `CommandService._tryExecuteCommand`.
  The palette surfaces this as *Command 'X' resulted in an error*.
- **Registered, never declared.** Fully executable — `executeCommand` works, keybindings can bind it,
  other extensions can call it — but no palette entry, no title, no icon, no `enablement`. This is
  exactly the documented pattern for internal commands.

`CommandsRegistry` stores a `LinkedList<ICommand>` per id and `getCommand` returns the first, with
registration doing `unshift`. Later registrations **shadow** earlier ones and disposing restores the
previous — which is how an extension overrides a built-in command.

### 1.3 The palette's list, and `enablement` vs `when`

The palette is `MenuId.CommandPalette`, with an implicit-items pass that is the actual mechanism
behind "declared commands show up by default":

```ts
getMenuItems(id: MenuId): Array<IMenuItem | ISubmenuItem> {
    ...
    if (id === MenuId.CommandPalette) {
        // CommandPalette is special because it shows all commands by default
        this._appendImplicitItems(result);
    }
    return result;
}

private _appendImplicitItems(result: Array<IMenuItem | ISubmenuItem>) {
    const set = new Set<string>();
    for (const item of result) {
        if (isIMenuItem(item)) { set.add(item.command.id); if (item.alt) { set.add(item.alt.id); } }
    }
    this._commands.forEach((command, id) => {
        if (!set.has(id)) { result.push({ command }); }
    });
}
```

Every `MenuRegistry.addCommand` is implicitly a palette item **unless** an explicit
`menus.commandPalette` entry for that id exists, in which case the explicit entry (with its `when`)
replaces the implicit one. That is what makes this idiom work:

```json
{
  "commands": [{ "command": "extension.sayHello", "title": "Hello World" }],
  "menus": {
    "commandPalette": [{ "command": "extension.sayHello", "when": "editorHasSelection" }]
  }
}
```

`"when": "false"` hides a command from the palette entirely.

The palette then applies both filters — `when` decides membership, `enablement` (now `precondition`)
decides enabled, and the palette drops disabled picks:

```ts
const globalCommandsMenu = this.menuService.getMenuActions(MenuId.CommandPalette, scopedContextKeyService);
const globalCommandsMenuActions = globalCommandsMenu
    .reduce((r, [, actions]) => [...r, ...actions], <...>[])
    .filter(action => action instanceof MenuItemAction && action.enabled) as MenuItemAction[];
```

The docs state the split plainly:

> "**Note** that `when` clauses apply to menus and `enablement` clauses to commands. The `enablement`
> applies to all menus and even keybindings while the `when` only applies to a single menu."

> "a command that analyzes a JavaScript regular expression should show **when** the file is
> JavaScript and be **enabled** only when the cursor is over a regular expression. The `when` clause
> prevents clutter, by not showing the command for all other language files."

| | `enablement` (on the command) | `when` (on a menu entry) |
|---|---|---|
| stored as | `ICommandAction.precondition` | `IMenuItem.when` |
| scope | every menu + keybindings | that one menu location |
| effect | greyed / disabled | absent from the menu |
| in the palette | filtered out | not listed |
| blocks `executeCommand`? | **No** | No |
| blocks a keybinding? | Yes | n/a |

### 1.4 Activation events

> "This activation event is emitted and interested extensions will be activated whenever a command is
> being invoked … **Note**: Beginning with VS Code 1.74.0, commands contributed by your extension do
> not require a corresponding `onCommand` activation event declaration for your extension to be
> activated."
> — [Activation events](https://code.visualstudio.com/api/references/activation-events)

The auto-generation is literal, in the extension point itself:

```ts
export const commandsExtensionPoint = ExtensionsRegistry.registerExtensionPoint<...>({
    extensionPoint: 'commands',
    jsonSchema: schema.commandsContribution,
    activationEventsGenerator: function* (contribs: readonly schema.IUserFriendlyCommand[]) {
        for (const contrib of contribs) {
            if (contrib.command) {
                yield `onCommand:${contrib.command}`;
            }
        }
    }
});
```

The lifecycle, which is the single most relevant fact in this whole document:

1. **Manifest parse. No extension code runs.** `contributes.commands` → `MenuRegistry.addCommand`.
   Title, category, precondition, icon and the palette entry all exist. *The command is enumerable
   before its handler has ever existed.*
2. User invokes it → `CommandService.executeCommand(id)` → `CommandsRegistry.getCommand(id)` is
   `undefined` → it awaits `activateByEvent('onCommand:' + id)` raced against the command being
   registered.
3. The extension host loads the module, calls `activate(context)`, `registerCommand` runs,
   `onDidRegisterCommand` fires and wins the race.
4. `_tryExecuteCommand` finds it and invokes it. Later invocations take the fast path
   (`activationEventIsDone`).

The cost of getting this wrong is visible in `CommandService._activateStar()`: for an unknown id it
races `activateByEvent('*')` against `timeout(30000)`, so an unresolvable id can hang for 30 seconds
and drag in every `*`-activated extension. `onStartupFinished` exists precisely to give extensions a
non-blocking alternative to `*`.

### 1.5 What `executeCommand` does

```ts
export function executeCommand<T = unknown>(command: string, ...rest: any[]): Thenable<T>;
```

> "*Note 1:* When executing an editor command not all types are allowed to be passed as arguments.
> Allowed are the primitive types `string`, `boolean`, `number`, `undefined`, and `null`, as well as
> `Position`, `Range`, `Uri` and `Location`. *Note 2:* There are no restrictions when executing
> commands that have been contributed by extensions."

Same-extension-host calls short-circuit entirely and never serialise:

```ts
// - We stay inside the extension host and support to pass any kind of parameters around.
// - We still emit the corresponding activation event BUT we don't await that event
this.#proxy.$fireCommandActivationEvent(id);
return this._executeContributedCommand<T>(id, args, false);
```

Cross-host calls convert args to DTOs and hit `MainThreadCommands.$executeCommand`, which will
activate and then deliberately throw `'$executeCommand:retry'` so the ext host can re-run locally
with un-serialised arguments. Then `CommandService.executeCommand` → `_tryExecuteCommand` →
`invokeFunction(command.handler, ...args)`, firing `onWillExecuteCommand` / `onDidExecuteCommand`.

The public `ICommandService`:

```ts
export interface ICommandService {
    readonly _serviceBrand: undefined;
    readonly onWillExecuteCommand: Event<ICommandEvent>;
    readonly onDidExecuteCommand: Event<ICommandEvent>;
    executeCommand<R = unknown>(commandId: string, ...args: unknown[]): Promise<R | undefined>;
}
```

Enumeration is `vscode.commands.getCommands(filterInternal?)`, which returns
`[...CommandsRegistry.getCommands().keys()]` — the **handler** registry. Declared-but-unregistered
commands are absent; registered-but-undeclared ones are present. "Internal" is just a leading
underscore, filtered client-side.

### 1.6 Argument typing: opt-in, and not available to extensions

There *is* a validation mechanism. `ICommandMetadata`:

```ts
export interface ICommandMetadata {
    readonly description: ILocalizedString | string;
    readonly args?: ReadonlyArray<{
        readonly name: string;
        readonly isOptional?: boolean;
        readonly description?: string;
        readonly constraint?: TypeConstraint;
        readonly schema?: IJSONSchema;
    }>;
    readonly returns?: string;
}
```

`CommandsRegistry.registerCommand` wraps the handler when args metadata is present:

```ts
// add argument validation if rich command metadata is provided
if (idOrCommand.metadata && Array.isArray(idOrCommand.metadata.args)) {
    const constraints: Array<TypeConstraint | undefined> = [];
    for (const arg of idOrCommand.metadata.args) { constraints.push(arg.constraint); }
    const actualHandler = idOrCommand.handler;
    idOrCommand.handler = function (accessor, ...args: unknown[]) {
        validateConstraints(args, constraints);
        return actualHandler(accessor, ...args);
    };
}
```

`TypeConstraint` is `string | Function` — a `typeof` check, or a class (`instanceof` / `.constructor
===`), or an arity-1 predicate returning `true`. A real one, from `workspaceCommands.ts`:

```ts
CommandsRegistry.registerCommand({
    id: 'vscode.openFolder',
    handler: (accessor, uriComponents?: UriComponents, arg?: boolean | IOpenFolderAPICommandOptions) => { ... },
    metadata: {
        description: 'Open a folder or workspace in the current window or new window ...',
        args: [
            { name: 'uri', description: '(optional) Uri of the folder or workspace file to open. ...',
              constraint: (value: unknown) => value === undefined || value === null || value instanceof URI },
            { name: 'options', description: '(optional) Options. ...',
              constraint: (value: unknown) => value === undefined || typeof value === 'object' || typeof value === 'boolean' }
        ]
    }
});
```

Four caveats that matter:

- `schema` (`IJSONSchema`) is **not enforced at runtime** — it feeds docs and the keybindings
  editor's IntelliSense only.
- `validateConstraints` uses `Math.min(args.length, constraints.length)`; extra args are unchecked
  and there is no arity validation.
- The same metadata generates the public
  [built-in commands reference](https://code.visualstudio.com/api/references/commands) via the hidden
  `_generateCommandsDocumentation` command. Typed args and documented args are the same artifact.
- **The public `vscode.commands.registerCommand(id, callback, thisArg)` has no metadata parameter.**
  Metadata lives on the internal `ExtHostCommands.registerCommand` overload used by VS Code's own API
  commands. So *extension-authored commands get zero argument validation and zero typing*; the `T` in
  `executeCommand<T>` is an unchecked cast and `...rest` is `any[]`.

### 1.7 Keybindings

```json
{
  "contributes": {
    "keybindings": [
      { "command": "extension.sayHello", "key": "ctrl+f1", "mac": "cmd+f1", "when": "editorTextFocus" }
    ]
  }
}
```

The docs page omits `args`, but it is in the extension-point schema
([`keybindingService.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/keybinding/browser/keybindingService.ts#L93)):

```ts
const keybindingType = {
    type: 'object',
    default: { command: '', key: '' },
    required: ['command', 'key'],
    properties: {
        command: { description: 'Identifier of the command to run when keybinding is triggered.', type: 'string' },
        args:    { description: "Arguments to pass to the command to execute." },   // no `type` — any JSON
        key:     { description: 'Key or key sequence (separate keys with plus-sign and sequences with space, e.g. Ctrl+O and Ctrl+L L for a chord).', type: 'string' },
        mac: { ... }, linux: { ... }, win: { ... },
        when:    { description: 'Condition when the key is active.', type: 'string' },
    }
}
```

**A keybinding binds to a command id string plus one optional argument value. Never to a function.**
The resolver's success result carries no callable:

```ts
| { kind: ResultKind.KbFound; commandId: string | null; commandArgs: any; isBubble: boolean };
```

and dispatch goes through the command service by id:

```ts
this._log(`+ Invoking command ${resolveResult.commandId}.`);
if (typeof resolveResult.commandArgs === 'undefined') {
    this._commandService.executeCommand(resolveResult.commandId).then(undefined, err => this._notificationService.warn(err));
} else {
    this._commandService.executeCommand(resolveResult.commandId, resolveResult.commandArgs).then(undefined, err => this._notificationService.warn(err));
}
```

`args` is what lets two keybindings bind the **same** command id with different arguments:

```json
{ "key": "enter", "command": "type", "args": { "text": "Hello World" }, "when": "editorTextFocus" }
```

Nothing keys off command id for uniqueness — rules are a flat list.

### 1.8 Keybinding resolution

[`keybindingResolver.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/keybinding/common/keybindingResolver.ts).
Defaults and user overrides are concatenated in that order:

```ts
constructor(
    /** built-in and extension-provided keybindings */
    defaultKeybindings: ResolvedKeybindingItem[],
    /** user's keybindings */
    overrides: ResolvedKeybindingItem[],
    log: (str: string) => void
) {
    ...
    this._keybindings = KeybindingResolver.handleRemovals(
        ([] as ResolvedKeybindingItem[]).concat(defaultKeybindings).concat(overrides));
```

Rules are bucketed by first chord, and selection scans the bucket **backwards**:

```ts
private _findCommand(context: IContext, matches: ResolvedKeybindingItem[]): ResolvedKeybindingItem | null {
    for (let i = matches.length - 1; i >= 0; i--) {
        const k = matches[i];
        if (!KeybindingResolver._contextMatchesRules(context, k.when)) {
            continue;
        }
        return k;
    }
    return null;
}
```

> "Rules are evaluated from **bottom** to **top**. The first rule that matches both the `key` and
> `when` clause, is accepted."

Ordering within defaults comes from `KeybindingWeight` (`EditorCore = 0`, `EditorContrib = 100`,
`WorkbenchContrib = 200`, `BuiltinExtension = 300`, `ExternalExtension = 400`) — higher sorts later,
therefore wins. User `keybindings.json` is simply appended last.

**The single most consequential line: `continue`, not `return null`.** A `when` clause is part of the
*match predicate*, not a post-selection guard. A higher-priority rule whose `when` is false is not a
candidate, and the scan falls through to lower-priority rules. Concretely: binding `ctrl+b` to your
own command with `"when": "myPanelFocused"` does **not** break the default sidebar toggle when your
panel is unfocused. It is also what makes the complementary-binding idiom work:

```json
{ "key": "f5", "command": "workbench.action.debug.continue", "when": "inDebugMode" },
{ "key": "f5", "command": "workbench.action.debug.start",    "when": "!inDebugMode" }
```

Only when *no* rule in the bucket matches does the key do nothing.

**Unbind vs shadow are different operations.**

```json
{ "key": "tab", "command": "-jumpToNextSnippetPlaceholder" }   // removal
{ "key": "tab", "command": "" }                                 // shadow
```

`handleRemovals` deletes the rule, so lower-priority rules become reachable. An empty command is kept
as a real winning rule that dispatches nothing — it consumes the key and blocks fall-through. Two
further details worth noting:

- Removals only delete *defaults* (`!rule.isDefault` short-circuits); a user rule cannot remove
  another user rule.
- Matching is by **`when`-implication, not equality**, deliberately:

  ```ts
  // Use implication instead of strict equality so that a removal still matches
  // when the default keybinding's when clause becomes more specific across
  // updates (e.g. "inChatInput" → "inChatInput && !withinEditSessionDiff").
  if (!KeybindingResolver.whenIsEntirelyIncluded(defaultWhen, removalWhen)) { return false; }
  ```

  A user's unbind survives you tightening a default's `when` in a later release.

**Chords** are `ctrl+k ctrl+c`, arbitrary depth, and the resolver is pure — state lives in the
service:

```ts
public resolve(context: IContext, currentChords: string[], keypress: string): ResolutionResult {
```
```ts
export const enum ResultKind {
    NoMatchingKb,      /** No keybinding found this sequence of chords */
    MoreChordsNeeded,  /** There're several keybindings that have the given sequence of chords as a prefix */
    KbFound            /** A single keybinding found to be dispatched/invoked */
}
```

`AbstractKeybindingService` holds `_currentChords`, shows *"(Ctrl+K) was pressed. Waiting for second
key of chord..."*, disables IME while in chord mode, and bails on focus loss or a 5-second timeout.

### 1.9 Conflict detection: a UI affordance, never an error

> "If you have many extensions installed or you have modified your keyboard shortcuts, there might be
> keyboard shortcut conflicts … Right-click on an item in the list of keyboard shortcuts, and select
> **Show Same Keybindings** to view all entries with the same keyboard shortcut."

The command id says conflicts; the implementation is a search-box filter:

```ts
export const KEYBINDINGS_EDITOR_COMMAND_SHOW_SIMILAR = 'keybindings.editor.showConflicts';
```
```ts
showSimilarKeybindings(keybindingEntry: IKeybindingItemEntry): void {
    const value = `"${keybindingEntry.keybindingItem.keybinding.getAriaLabel()}"`;
    if (value !== this.searchWidget.getValue()) {
        this.searchWidget.setValue(value);
    }
}
```

There is no validation pass, no warning, no diagnostic. Duplicate key with overlapping `when` is a
legal and extremely common state — it is *the mechanism by which layering works*. The related
affordances are `keybindings.editor.recordSearchKeys` ("Record Keys"),
`keybindings.editor.toggleSortByPrecedence` (sorts in resolution order — the closest thing to a real
conflict view), and **Developer: Toggle Keyboard Shortcuts Troubleshooting**, which logs the winning
rule, its serialised `when`, and its source.

### 1.10 `when` clauses: declarative read, imperative write

The grammar is an EBNF comment in
[`contextkey.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/contextkey/common/contextkey.ts#L93):

```ebnf
expression ::= or
or  ::= and { '||' and }*
and ::= term { '&&' term }*
term ::= '!' (KEY | true | false | parenthesized) | primary
primary ::= 'true' | 'false' | parenthesized
          | KEY '=~' REGEX
          | KEY [ ('==' | '!=' | '<' | '<=' | '>' | '>=' | 'not' 'in' | 'in') value ]
```

Precedence `!` > `&&` > `||`. Built-in contexts include `editorTextFocus`, `editorLangId`,
`resourceExtname`, `isMac`, `view`, `viewItem`, `focusedView`, `inputFocus`, and settings via a
`config.` prefix. Extensions add their own imperatively:

```js
vscode.commands.executeCommand('setContext', 'myExtension.showMyCommand', true);
vscode.commands.executeCommand('setContext', 'ext.supportedFolders', ['test', 'foo', 'bar']);
```

`setContext` is itself just a command:

```ts
export function setContext(accessor: ServicesAccessor, contextKey: any, contextValue: any) {
    const contextKeyService = accessor.get(IContextKeyService);
    contextKeyService.createKey(String(contextKey), stringifyURIs(contextValue));
}
```

The asymmetry is the architecture. **Writing is imperative and scattered** — any code, any time,
fire-and-forget. **Reading is declarative and data-only** — a `when` string in a manifest. Producers
never know their consumers, so a keybinding in one extension's `package.json` can depend on a context
key set by an unrelated extension with no import, no handshake, and no load-order dependency. The key
namespace is the entire coupling surface.

Internally VS Code avoids the stringly-typed version with `RawContextKey`, which **is** an expression
(it extends `ContextKeyDefinedExpr`), so it composes without a string round-trip:

```ts
public bindTo(target: IContextKeyService): IContextKey<T> { return target.createKey(this.key, this._defaultValue); }
public isEqualTo(value: any): ContextKeyExpression { return ContextKeyEqualsExpr.create(this.key, value); }
```

**Evaluation is synchronous, pure, and cheap** — a recursive tree walk with short-circuiting over an
immutable AST parsed once at registration:

```ts
public evaluate(context: IContext): boolean {
    for (let i = 0, len = this.expr.length; i < len; i++) {
        if (!this.expr[i].evaluate(context)) { return false; }
    }
    return true;
}
```

That constraint is forced by the resolver calling it in a loop over a whole key bucket on **every
keystroke**. No function calls, no async, no user code in a `when`.

**`keys()` is what makes the declarative side affordable.** Every expression can report which context
keys it reads, so consumers build a dependency set once and filter change events against it.
`menuService.ts` keeps *three* such sets:

```ts
private _collectContextKeysAndSubmenuIds(item: IMenuItem | ISubmenuItem): void {
    MenuInfoSnapshot._fillInKbExprKeys(item.when, this._structureContextKeys);
    if (isIMenuItem(item)) {
        // keep precondition keys for event if applicable
        if (item.command.precondition) {
            MenuInfoSnapshot._fillInKbExprKeys(item.command.precondition, this._preconditionContextKeys);
        }
        // keep toggled keys for event if applicable
        ...
    }
}
```

so a change to a toggled-only key repaints a checkmark instead of rebuilding the menu. A static
dependency graph extracted from the expressions themselves, requiring nothing of the author.

**Context is scoped by DOM ancestry**, resolved from the event target per keystroke:

```ts
const KEYBINDING_CONTEXT_ATTR = 'data-keybinding-context';

function findContextAttr(domNode: IContextKeyServiceTarget | null): number {
    while (domNode) {
        if (domNode.hasAttribute(KEYBINDING_CONTEXT_ATTR)) { ... }
        domNode = domNode.parentElement;
    }
    return 0;   // root context
}
```

with values inheriting up the parent chain. "Which panel is this key for?" is answered by the focused
element, not by a hand-maintained focus state machine.

### 1.11 `registerAction2` — core VS Code's own unified declaration

This is the shape most worth reading, because it is what VS Code uses for itself rather than for
extensions. One declaration fans out to four registries:

```ts
export function registerAction2(ctor: { new(): Action2 }): IDisposable {
    const disposables: IDisposable[] = [];
    const action = new ctor();
    const { f1, menu, keybinding, ...command } = action.desc;

    if (CommandsRegistry.getCommand(command.id)) {
        throw new Error(`Cannot register two commands with the same id: ${command.id}`);
    }

    // command
    disposables.push(CommandsRegistry.registerCommand({
        id: command.id,
        handler: (accessor, ...args) => action.run(accessor, ...args),
        metadata: command.metadata ?? { description: action.desc.title }
    }));

    // menu
    ... MenuRegistry.appendMenuItem(item.id, { command: { ...command, precondition: ... }, ...item }) ...
    if (f1) {
        disposables.push(MenuRegistry.appendMenuItem(MenuId.CommandPalette, { command, when: command.precondition }));
        disposables.push(MenuRegistry.addCommand(command));
    }

    // keybinding
    ... KeybindingsRegistry.registerKeybindingRule({
        ...item,
        id: command.id,
        when: command.precondition ? ContextKeyExpr.and(command.precondition, item.when) : item.when
    }) ...
}
```

Note `keybinding?: OneOrN<Omit<IKeybindingRule, 'id'>>` — one or many, each with its own `args` and
`when`.

**`precondition` is ANDed mechanically into every surface's condition.** The semantic split:

- **`precondition`** — "can this command meaningfully run at all right now?" One declaration, applies
  everywhere, governs enablement and gates every keybinding.
- **`when`** — "should this *particular surface* be active or visible?" Per-keybinding,
  per-menu-item. About scope, not capability.

Because the precondition is conjoined into the keybinding's `when`, and because `when` is a match
predicate (§1.8), a disabled action's key **falls through** rather than being swallowed. That
correct behaviour is emergent, not special-cased.

A real one:

```ts
registerAction2(class ReplaceInFilesAction extends Action2 {
    constructor() {
        super({
            id: Constants.SearchCommandIds.ReplaceInFilesActionId,
            title: nls.localize2('replaceInFiles', "Replace in Files"),
            keybinding: [{
                primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyH,
                weight: KeybindingWeight.WorkbenchContrib,
            }],
            category,
            f1: true,
            precondition: IsSessionsWindowContext.negate(),
            menu: [{ id: MenuId.MenubarEditMenu, group: '4_find_global', order: 2, when: IsSessionsWindowContext.negate() }],
        });
    }

    override async run(accessor: ServicesAccessor): Promise<any> {
        return await findOrReplaceInFiles(accessor, true);
    }
});
```

The older editor path (`EditorAction` / `EditorCommand`) is the same idea with `kbOpts.kbExpr` in
place of the keybinding's `when` — and it *does* re-check the precondition at invocation time, so
palette and programmatic invocation are gated too:

```ts
return editor.invokeWithinContext((editorAccessor) => {
    const kbService = editorAccessor.get(IContextKeyService);
    if (!kbService.contextMatchesRules(precondition ?? undefined)) {
        // precondition does not hold
        return;
    }
    return runner(editorAccessor, editor, args);
});
```

A three-layer example worth internalising — capability, scope, surface:

```ts
super({
    id: 'editor.action.formatSelection',
    label: nls.localize2('formatSelection.label', "Format Selection"),
    precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasDocumentSelectionFormattingProvider),
    kbOpts: {
        kbExpr: EditorContextKeys.editorTextFocus,
        primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyF),
        weight: KeybindingWeight.EditorContrib
    },
    contextMenuOpts: { when: EditorContextKeys.hasNonEmptySelection, group: '1_modification', order: 1.31 }
});
```

---

## 2. Blender

Sources: the Blender 5.1 Python API reference and user manual (bundled RST), plus
`blender/blender` `main` C++ where behaviour is not documented.

### 2.1 The operator declaration

```python
import bpy
from bpy.props import FloatProperty, EnumProperty


class MESH_OT_bump_terrain(bpy.types.Operator):
    """Raise or lower terrain under the cursor"""   # -> bl_description if unset
    bl_idname = "mesh.bump_terrain"
    bl_label = "Bump Terrain"
    bl_options = {'REGISTER', 'UNDO'}
    bl_undo_group = "Bump Terrain"

    radius: FloatProperty(
        name="Radius", description="Brush radius",
        default=1.0, min=0.0, max=100.0, soft_min=0.1, soft_max=10.0,
        subtype='DISTANCE', unit='LENGTH',
    )
    mode: EnumProperty(
        name="Mode",
        items=(('RAISE', "Raise", "Push terrain up"),
               ('LOWER', "Lower", "Push terrain down")),
        default='RAISE',
    )

    @classmethod
    def poll(cls, context):
        ob = context.active_object
        if ob is None:
            cls.poll_message_set("No active object")
            return False
        return ob.type == 'MESH'

    def execute(self, context):
        ...
        return {'FINISHED'}
```

| Field | Notes |
|---|---|
| `bl_idname` | The registry key, dotted `category.name` |
| `bl_label` | UI name — what search matches on, and what the undo step is named |
| `bl_description` | Tooltip; falls back to the class docstring |
| `bl_options` | Registry-level policy flags (below) |
| `bl_undo_group` | Coalescing bucket for `'UNDO_GROUPED'`; falls back to `bl_label` |
| `bl_property` | Primary property, used by `invoke_search_popup` |

`bl_idname` is validated at registration by `operator_idname_ok_or_report_impl()`: lowercase
`a`–`z`, digits, `_` and `.` only; **exactly one** `.`, neither first nor last; length capped at 61.
The dotted form is mangled into an RNA identifier — `mesh.subdivide` ⇄ `MESH_OT_subdivide`.

`bl_options`, verbatim from `operator_type_flag_items`:

- `REGISTER` — "Display in the info window and support the redo toolbar panel."
- `UNDO` — "Push an undo event when the operator returns `FINISHED` (needed for operator redo,
  mandatory if the operator modifies Blender data)."
- `UNDO_GROUPED` — "Push a single undo event for repeated instances of this operator."
- `BLOCKING`, `GRAB_CURSOR`, `GRAB_CURSOR_X`, `GRAB_CURSOR_Y`, `DEPENDS_ON_CURSOR`, `MODAL_PRIORITY`
- `PRESET` — "Display a preset button with the operators settings."
- `INTERNAL` — "**Removes the operator from search results.**"
- `MACRO` — "Use to check if an operator is a macro."

Two corrections to commonly-repeated folklore, both checked: **there is no `'MODAL'` flag** (modality
comes from defining `modal()` and calling `modal_handler_add`), and **`bl_context` is not an Operator
field** — it exists only on `bpy.types.Panel`. Operators have *no declarative scoping field at all*.

### 2.2 Declaration vs handler

The class body is pure metadata plus a typed property schema. The callables are the handler set, all
optional; which ones you define determines what the command can do.

| Method | Role | Returns |
|---|---|---|
| `poll(cls, context)` | availability predicate (classmethod) | `bool` |
| `execute(self, context)` | **the handler.** Non-interactive; every input comes from `self.<prop>` | return set |
| `invoke(self, context, event)` | **interactive entry.** Seeds properties from the event, then calls `execute`, opens a popup, or starts a modal loop | return set |
| `modal(self, context, event)` | per-event tick of a drag loop | return set |
| `draw(self, context)` | custom layout for the redo panel / dialog | `None` |
| `check(self, context)` | "return True to signal a change to redraw" | `bool` |
| `description(cls, context, properties)` | **dynamic tooltip computed from the bound argument values** | `str` |

Return values, verbatim from `operator_return_items`:

- `RUNNING_MODAL` — "Keep the operator running with blender."
- `CANCELLED` — "The operator exited without doing anything, **so no undo entry should be pushed**."
- `FINISHED` — "The operator exited after completing its action."
- `PASS_THROUGH` — "Do nothing and pass the event on."
- `INTERFACE` — "Handled but not executed (popup menus)."

Which handler runs:

> When an operator is called via `bpy.ops`, the execution context depends on the argument provided to
> `bpy.ops`. By default, it uses `execute()`. When an operator is activated from a button or menu
> item, it follows the setting in `UILayout.operator_context`. In most cases, `invoke()` is used.
> **Running an operator via a key shortcut always uses `invoke()`, and this behavior cannot be
> changed.**

And a constraint worth flagging loudly: *"Some operators don't have an `execute()` function, removing
the ability to be repeated from a script or macro."* Confirmed in
`WM_operator_repeat_check()`, which returns `false` unless `ot->exec != nullptr`. **An invoke-only
operator cannot be redone, repeated, or scripted with arguments.**

The canonical modal operator shows the shape that matters most for a viewport tool — `modal()`
mutates properties and delegates to the *same* `execute()` the keyboard and a script call:

```python
def modal(self, context, event):
    if event.type == 'MOUSEMOVE':                 # Apply.
        self.value = event.mouse_x
        self.execute(context)
    elif event.type == 'LEFTMOUSE':               # Confirm.
        return {'FINISHED'}
    elif event.type in {'RIGHTMOUSE', 'ESC'}:     # Cancel.
        context.object.location.x = self.init_loc_x
        return {'CANCELLED'}
    return {'RUNNING_MODAL'}

def invoke(self, context, event):
    self.init_loc_x = context.object.location.x
    self.value = event.mouse_x
    self.execute(context)
    context.window_manager.modal_handler_add(self)
    return {'RUNNING_MODAL'}
```

### 2.3 `poll()`: availability as arbitrary code

```python
@classmethod
def poll(cls, context):
    return context.object is not None
```

This is **arbitrary Python over the whole context**, evaluated on demand. No expression language, no
static analysis, no serialised form — the exact opposite of VS Code's `when`. Consequences:

- Availability cannot be computed without running user code. There is even an assertion guarding
  against side effects: `BLI_assert_msg(..., "Operator polls shouldn't change button flags")`.
- You cannot index or query it offline. "Which commands are available in state X?" is unanswerable
  without a live context.

In the UI, every operator button re-polls on **every layout pass**:

```cpp
/* temp? Proper check for graying out */
if (but.optype) {
  wmOperatorType *ot = but.optype;
  if (ot == nullptr || !button_context_poll_operator(const_cast<bContext *>(C), ot, &but)) {
    but.flag |= BUT_DISABLED;
  }
}
```

Buttons and menu items are greyed. Search results are *filtered out entirely* (§2.5). From Python you
get an exception rather than a silent no-op:

```
>>> bpy.ops.action.clean(threshold=0.001)
RuntimeError: Operator bpy.ops.action.clean.poll() failed, context is incorrect
```

The guard idiom is `if bpy.ops.object.mode_set.poll(): ...`.

**`poll_message_set` exists**, and is the "why not" channel:

```
.. classmethod:: poll_message_set(message, *args)
   Set the message to show in the tool-tip when poll fails.
```

It surfaces in two places — a red alert line in the tooltip, and in place of "failed, context is
incorrect" in the Python exception:

```
>>> bpy.ops.object.vertex_group_add()
RuntimeError: Operator bpy.ops.object.vertex_group_add.poll() No active editable object
```

Blender's own docs are candid that this was bolted on late and is under-used: *"Blender does have the
functionality for poll functions to describe why they fail, but it's currently not used much."* And
the gotchas page admits the cost of the boolean-only default: *"unfortunately, the only way to
eventually know what is causing the error is to read the source code for the poll function."*

### 2.4 Operator properties: one typed schema, five consumers

This is the strongest part of the design.

> These properties are handled differently to typical Python class attributes because Blender needs to
> display them in the interface, **store their settings in keymaps** and keep settings for reuse.

All `bpy.props` parameters are keyword-only:

```python
FloatProperty(*, name="", description="", translation_context="*",
              default=0.0,
              min=-3.402823e+38, max=3.402823e+38,
              soft_min=-3.402823e+38, soft_max=3.402823e+38,
              step=3, precision=2,
              options={'ANIMATABLE'}, override=set(), tags=set(),
              subtype='NONE', unit='NONE',
              update=None, get=None, set=None, ...)
```

Documented validation semantics:

- `min` — "Hard minimum, **trying to assign a value below will silently assign this minimum
  instead**."
- `soft_min` — "Soft minimum (>= *min*), **user won't be able to drag the widget below this value in
  the UI**."
- `description` — "Text used for the tooltip **and api documentation**."

Note the hard/soft split, and note that hard bounds are a **clamp, not an error**. There is no
validation-failure path: out-of-range arguments are silently coerced. A deliberate trade — a scripted
call never fails on a bad number — and one to decide on explicitly rather than inherit.

`subtype` and `unit` carry semantics into the widget: `FloatProperty(subtype='DISTANCE',
unit='LENGTH')` makes the field accept `2m` or `6'` per the scene's unit system, for free.

The single schema feeds **five** consumers:

1. **The redo panel UI**, auto-generated. Overridable with `draw(self, context)`.
2. **Tooltips and generated API docs**, from `description=`.
3. **The keymap item's stored argument bundle** — `kmi.properties.total = 4` (§2.6).
4. **The scripted call signature** — the published docs for
   `primitive_cube_add(*, size=2.0, calc_uvs=True, enter_editmode=False, align='WORLD', ...)` are
   literally the schema.
5. **Presets** (`bl_options={'PRESET'}`) and menu-button pre-binding, where `layout.operator()`
   returns an `OperatorProperties` you write into.

One flag matters enormously and is easy to miss. By default Blender **persists the last-used value of
every operator property** and re-seeds the next invocation from it
(`WM_operator_last_properties_init` / `..._store`). To opt out, per property:

- `SKIP_SAVE` — "For operators: **the value of this property will not be remembered between
  invocations of the operator**; instead, each invocation will start by using the default value."
- `HIDDEN` — "For operators: hide from places in the user interface where Blender would add the
  property automatically, like Adjust Last Operation."

Sticky arguments are on by default. For a transient argument like a mouse position you *must* opt
out.

### 2.5 Invocation from script, and enumeration

```python
bpy.ops.mesh.subdivide(number_cuts=3, smoothness=0.5)
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 0))
```

> "Only keyword arguments can be used to pass operator properties."

Two positional arguments are allowed, in order: `execution_context` (string) then `undo` (bool).
`bpy/ops.py::_parse_args` raises `ValueError("string arg must come before the boolean")` otherwise.
The enum is `INVOKE_DEFAULT`, `INVOKE_REGION_WIN`, `INVOKE_AREA`, `INVOKE_SCREEN`, `EXEC_DEFAULT`,
`EXEC_REGION_WIN`, and so on — the prefix chooses the handler, the suffix chooses which region or
area the context is resolved against.

```python
# Invoke it: settings are taken from the mouse (runs invoke()).
bpy.ops.wm.mouse_position('INVOKE_DEFAULT')

# Call execute() directly with pre-defined settings.
bpy.ops.wm.mouse_position('EXEC_DEFAULT', x=20, y=66)
```

**The unification is real and enforced at one place in C.** The keymap path
(`wm_handler_operator_call`) and the Python path (`bpy_operator_function.cc` →
`WM_operator_name_call_ptr`) both land in `wm_operator_invoke(C, ot, event, properties, …)`.
Keymap-supplied `kmi->ptr` and Python-supplied `**kwargs` arrive as the same `PointerRNA *properties`.
**A keybinding and a scripted call are the same call with a different argument source.**

Return is a `set`, not a value. Errors travel out of band:

> if there are error reports, a `RuntimeError` will be raised after the operator finishes execution,
> including all error report messages, regardless of the return status (even if it was
> `{'FINISHED'}`).

The registry is fully enumerable and introspectable:

```python
dir(bpy.ops)                                   # -> ['mesh', 'object', 'wm', ...]
dir(bpy.ops.mesh)                              # -> ['subdivide', 'primitive_cube_add', ...]
bpy.ops.mesh.primitive_cube_add.idname()       # -> 'MESH_OT_primitive_cube_add'
bpy.ops.mesh.primitive_cube_add.poll()         # -> bool
bpy.ops.mesh.primitive_cube_add.get_rna_type() # -> full typed property schema
bpy.ops.mesh.primitive_cube_add.bl_options     # -> {'REGISTER', 'UNDO'}
```

`dir()` is implemented by splitting every registered idname on `_OT_` — the namespace is derived, not
declared. `get_rna_type()` gives machine-readable access to any command's schema, built-in or not.
There is even `bpy.ops.wm.operator_cheat_sheet()`, which dumps every operator with its defaults.

The worst consequence of the design, from the gotchas page:

> - Can't pass data such as objects, meshes or materials to operate on (**operators use the context
>   instead**).
> - The return value from calling an operator is the success […] in some cases it would be more
>   logical from an API perspective to return the result of the operation.

Operators take no object arguments — only typed scalars plus an ambient context. Every "operate on
*that* thing" becomes a `context.temp_override(**overrides)` dance.

### 2.6 F3 search

There are **two** searches, routinely conflated:

- **Menu Search** (`wm.search_menu`, **F3**) searches *menu entries*, not the registry. An operator
  appears only if it has been placed in a menu — which is why every example script in the API docs
  appends a `menu_func` with the comment "required to also use F3 search".
- **Operator Search** (`wm.search_operator`, **Developer Extras only**) — "This menu searches all
  operators within Blender, even if they are not exposed in a menu."

Operator Search's population, from `interface_template_search_operator.cc` (file header: *"Search
available operators by scanning all and checking their poll function."*):

```cpp
for (wmOperatorType *ot : WM_operatortypes_registered_get()) {
  const char *ot_ui_name = CTX_IFACE_(ot->translation_context, ot->name);

  if ((ot->flag & OPTYPE_INTERNAL) && (G.debug & G_DEBUG_WM) == 0) {
    continue;
  }

  if (BLI_string_all_words_matched(ot_ui_name, str, ..., words_len)) {
    if (WM_operator_poll(const_cast<bContext *>(C), ot)) {
      std::string name = ot_ui_name;
      if (const std::optional<std::string> kmi_str = WM_key_event_operator_string(...)) {
        name += UI_SEP_CHAR;
        name += *kmi_str;          /* the bound shortcut, right-aligned */
      }
      if (!search_item_add(items, name, ot, ICON_NONE, 0, 0)) break;
    }
  }
}
```

Four facts: the source is the **global registry**; `'INTERNAL'` hides an entry unless launched with
`--debug-wm`; matching is on `bl_label` (translated), **not** on `bl_idname`; and poll-failing
operators are **omitted entirely** rather than greyed, re-polled on every keystroke.

Execution is `WM_operator_name_call_ptr(C, ot, InvokeDefault, nullptr, nullptr)` — note the `nullptr`
properties. **Search always runs with defaults or last-used values and cannot supply arguments.** A
palette that cannot pass arguments is a real limitation given how much the property schema buys
everywhere else.

Identifier discoverability sits behind two off-by-default preferences: **Developer Extras** (which
enables Operator Search and "Copy Python Command") and **Python Tooltips** ("Displays a property's
Python information below the tooltip"). In a system where keybindings are configured by typing a raw
idname, that is notable friction.

### 2.7 Keymaps

Four key configurations: `.default` (builtin), `.addon` ("Key configuration that can be extended by
add-ons"), `.user` (the merged, editable result), and `.active`.

A `KeyMapItem` is the binding record:

```python
new(idname, type, value, *, any=False, shift=0, ctrl=0, alt=0, oskey=0, hyper=0,
    key_modifier='NONE', direction='ANY', repeat=False, head=False)
```

- `.idname` — "Identifier of operator to call on input event" — a **raw string**, not a reference.
- `.properties` — "**Properties to set when the operator is called**" (`OperatorProperties`).
- `.active` — "Activate or deactivate item".
- `head` — "Force item to be added at start (not end) of key map **so that it doesn't get blocked by
  an existing key map item**" — a direct admission that order *is* the conflict mechanism.

The canonical add-on registration, and note the argument bundle:

```python
addon_keymaps = []

def register():
    wm = bpy.context.window_manager
    km = wm.keyconfigs.addon.keymaps.new(name='Object Mode', space_type='EMPTY')
    kmi = km.keymap_items.new(ObjectCursorArray.bl_idname, 'T', 'PRESS', ctrl=True, shift=True)
    kmi.properties.total = 4                 # <-- the ARGS for this binding
    addon_keymaps.append((km, kmi))

def unregister():
    for km, kmi in addon_keymaps:
        km.keymap_items.remove(kmi)
    addon_keymaps.clear()
```

So a keybinding is `(event pattern) → (operator id, property bundle)` — which is how one
`view3d.view_axis` serves all seven numpad view keys. `find_from_operator(idname, properties=...)`
answers "what key runs this command with these args", which is how tooltips show shortcuts.

Keymaps are scoped by `(name, space_type, region_type)`, arranged in a hierarchy — `Window`, `Screen`,
`View2D`, `3D View` → `Object Mode` / `Mesh` / `Sculpt` / `Pose`, and so on.

**Conflict detection: there is none.** Confirmed three ways. The manual's "Known Limitations" section
covers only version-upgrade breakage; the keymap-editing page handles conflicts by *advice* ("here are
keys which aren't used and aren't likely to be used"); and an open WIP PR (`#163760`, "Keymap Editor
Experiments: usage history, **conflicts**, multi-select…") is still trying to add it.

The actual resolution algorithm, `wm_handlers_do_keymap_with_keymap_handler`:

```cpp
if (WM_keymap_poll(C, keymap)) {
  for (wmKeyMapItem &kmi : keymap->items) {
    if (wm_eventmatch(event, &kmi)) {
      action |= wm_handler_operator_call(C, handlers, &handler->head, event, kmi.ptr, kmi.idname);
      if (action & WM_HANDLER_BREAK) {
        break;
      }
    }
  }
}
```

First match wins, in list order — **but only if it actually handles the event**. Three gates in order:

1. `WM_keymap_poll(C, keymap)` — the whole keymap can decline. This is the mode/space scoping.
2. `wm_eventmatch(event, &kmi)`, whose very first check is `if (kmi->flag & KMI_INACTIVE) return
   false;` — i.e. `kmi.active = False` is skipped as if absent. This is how an add-on "removes" a
   default binding without deleting it.
3. **The operator's own `poll()`**. If it fails, `retval` stays at `OPERATOR_PASS_THROUGH`, which maps
   to `WM_HANDLER_CONTINUE` — **the event falls through to the next matching keymap item.**

**`poll()` is the de-facto conflict resolver.** Two items on the same key coexist as long as their
polls are disjoint. That is why Blender gets away with no detection — and also why static detection
would be *impossible* here: it would require proving two arbitrary Python predicates disjoint.

Note the structural parallel with VS Code: "winning rule declines → fall through to the next" is the
same behaviour as `_findCommand`'s `continue`. Both systems arrived at it; only VS Code's version is
statically analysable.

Handler dispatch order, reading `wm_event_do_handlers` top to bottom: **modal handlers first**
("First we do priority handlers, modal + some limited key-maps" — a running modal operator sees the
event before anything else), then drag-and-drop, then region, then area, then window. Each step
guarded by `if ((action & WM_HANDLER_BREAK) == 0)`. Most-specific first, stop at the first break.

### 2.8 Undo, and how redo re-runs the handler

> Any operator modifying Blender data should enable the `'UNDO'` option. This will make Blender
> automatically create an undo step when the operator finishes its `execute` (or `invoke`) functions,
> and returns `{'FINISHED'}`. Otherwise, no undo step will be created, which will at best corrupt the
> undo stack and confuse the user […] **In many cases, this can even lead to data corruption and
> crashes.**

The mechanism, `wm_operator_finished()`:

```cpp
/* We don't want to do undo pushes for operators that are being
 * called from operators that already do an undo push. Usually
 * this will happen for python operators that call C operators. */
if (wm->op_undo_depth == 0) {
  if (op->type->flag & OPTYPE_UNDO) {
    ED_undo_push_op(C, op);
    ...
  }
  else if (op->type->flag & OPTYPE_UNDO_GROUPED) {
    ED_undo_grouped_push_op(C, op);
    ...
  }
}
```

Three things to take from this:

- **Undo is a registry-level policy flag, not something each handler implements.** No operator writes
  an `undo()` method — the same principle as our `Patch`/`inverse` applier.
- **The `op_undo_depth` nesting guard** means an operator that calls other operators produces *one*
  undo step, not N. This is what makes composition safe.
- The step is **named after `bl_label`** (`ED_undo_push(C, op->type->name, hints)`), which is what
  appears in Edit ▸ Undo History.

**"Adjust Last Operation" (F9) is the interesting part.** `ED_undo_operator_repeat`:

```cpp
if (WM_operator_repeat_check(C, op) && WM_operator_poll(C, op->type) && !WM_jobs_has_running(...)) {
  WM_operator_free_all_after(wm, op);

  ED_undo_pop_op(C, op);            /* <-- UNDO the previous run of THIS operator */

  if (op->type->check) { op->type->check(C, op); }   /* re-layout the popup */

  const wmOperatorStatus retval = WM_operator_repeat(C, op);   /* <-- RE-RUN exec() */
  if ((retval & OPERATOR_FINISHED) == 0) {
    ED_undo_redo(C);                /* restore if the re-run failed */
  }
}
```

So editing a value in the redo panel: pops the previous step by name, re-runs **`execute()` only**
(never `invoke()`) on the *retained operator instance* carrying the new property values, pushes a
fresh step in its place, and restores if the re-run fails. `self.is_repeat()` is `True` during this.

That entire feature falls straight out of "arguments are a typed schema on a retained instance". It is
not a separate system.

`'UNDO_GROUPED'` coalesces consecutive runs keyed by `bl_undo_group` (falling back to `bl_label`):

```cpp
/* do nothing if previous undo task is the same as this one (or from the same undo group) */
if (ed_undo_grouped_check_by_name(ustack, str)) {
  BKE_undosys_stack_clear_active(ustack);   /* drop the previous step */
}
ED_undo_push(C, str, hints);                /* push as usual */
```

N consecutive identical operations become one Ctrl-Z — the mechanism for paint strokes and value
nudges, and `bl_undo_group` lets several *different* operators share a bucket.

Manual pushes exist (`bpy.ops.ed.undo_push`) but the docs warn: *"this is considered an advanced
feature and requires some understanding of the actual undo system in Blender code."*

### 2.9 Macros: composing commands

`bpy.types.Macro` has the same declaration surface as `Operator` but **no `execute`/`invoke`/`modal`**
— instead:

```python
def register():
    bpy.utils.register_class(OBJECT_OT_simple_macro)

    # Define steps AFTER registration and set operator values via .properties
    step = OBJECT_OT_simple_macro.define("transform.translate")
    props = step.properties
    props.value = (1.0, 0.0, 0.0)
    props.constraint_axis = (True, False, False)
```

Steps are defined by idname string, post-registration, and the referenced operator *need not exist
yet* — late binding. Each step carries its own frozen property bundle, the **same `(idname,
properties)` pairing as a keymap item**. The macro runs as one undo step (via `op_undo_depth`). A
macro is redoable only if every sub-operator has `exec`. The classic instance is
`object.duplicate_move` = `object.duplicate` + `transform.translate`, which is how Shift-D enters grab
mode.

Note what this means: `(idname, property bundle)` is Blender's universal currency. A keymap item, a
menu button's pre-bound props, a macro step, and a preset are all the same shape. That is one step
short of Photoshop's recordable descriptor list (§5) — the missing piece is only that arguments
cannot reference objects.

---

## 3. Godot editor plugins

### 3.1 `plugin.cfg` — identity, and nothing else

At `addons/<plugin_name>/plugin.cfg`:

```ini
[plugin]

name="My Custom Dock"
description="A custom dock made so I can learn how to make plugins."
author="Your Name Here"
version="1.0"
script="custom_dock.gd"
```

Five string fields. The manifest carries **no contribution data at all** — no commands, no menus, no
activation events. It is a name card plus a script pointer. Plugins are disabled by default and
enabled per-project by the user in **Project Settings > Plugins**; enabling is what instantiates the
script and runs `_enter_tree()`.

### 3.2 `EditorPlugin` — imperative registration, mandatory teardown

> "it must be a `@tool` script, or else it will not load properly in the editor, and it must inherit
> from EditorPlugin." / "Any GDScript without `@tool` used by the editor will act like an empty file!"

```gdscript
@tool
extends EditorPlugin

var dock

func _enter_tree():
    dock = preload("res://addons/my_custom_dock/my_dock.tscn").instantiate()
    add_control_to_dock(DOCK_SLOT_LEFT_UL, dock)

func _exit_tree():
    remove_control_from_docks(dock)
    dock.free()
```

Every contribution is an imperative call with a mirrored `remove_*`:

| Method | Note |
|---|---|
| `add_control_to_dock(slot, control, shortcut = null)` | Editor saves the dock position across sessions. Deprecated in favour of `add_dock()`. |
| `add_control_to_bottom_panel(control, title, shortcut = null) -> Button` | "It's up to you to hide/show the button when needed." |
| `add_control_to_container(container, control)` | "you have to manage the visibility of your custom controls yourself" |
| `add_custom_type(type, base, script, icon)` | |
| `add_tool_menu_item(name, callable)` | "Adds a custom menu item to Project > Tools named [param name]." |
| `add_autoload_singleton(name, path)` | |
| `add_inspector_plugin` / `add_import_plugin` / `add_export_plugin` / `add_scene_format_importer_plugin` | |

Nothing enforces the pairing. Since enable/disable is genuinely dynamic (no editor restart), a
forgotten `remove_*` leaks a dock, type or menu item into the running session — the characteristic
Godot plugin bug.

### 3.3 Claiming an object and owning viewport input

```
_handles(object: Object) -> bool
_edit(object: Object)
_make_visible(visible: bool)
_forward_3d_gui_input(viewport_camera: Camera3D, event: InputEvent) -> int
```

> "Implement this function if your plugin edits a specific type of object (Resource or Node). If you
> return `true`, then you will get the functions `_edit` and `_make_visible` called"

```gdscript
func _forward_3d_gui_input(camera, event):
    return EditorPlugin.AFTER_GUI_INPUT_STOP if event is InputEventMouseMotion else EditorPlugin.AFTER_GUI_INPUT_PASS
```

`AFTER_GUI_INPUT_PASS` forwards to other plugins, `AFTER_GUI_INPUT_STOP` consumes,
`AFTER_GUI_INPUT_CUSTOM` passes to everything except the main Node3D editor.

**The gate is `_handles`** — viewport input ownership is derived from *what is selected*, not from
which tool is active. There is no "active tool" concept at the API level.

### 3.4 Shortcuts and the command palette

A real named-command registry with remappable shortcuts exists — **Editor > Editor Settings >
Shortcuts** — but it is C++-internal. From `editor/editor_settings.h`:

```cpp
mutable HashMap<String, Ref<Shortcut>> shortcuts;

Ref<Shortcut> ED_SHORTCUT(const String &p_path, const String &p_name, Key p_keycode = Key::NONE, bool p_physical = false);
void ED_SHORTCUT_OVERRIDE(const String &p_path, const String &p_feature, Key p_keycode = Key::NONE, bool p_physical = false);
Ref<Shortcut> ED_GET_SHORTCUT(const String &p_path);
```

`p_path` is the stable id (`"editor/save_scene"`), `p_name` the label in the Shortcuts panel,
`p_keycode` the *default*, with user overrides persisted in editor settings.
`ED_SHORTCUT_OVERRIDE(path, "macos", ...)` declares per-platform defaults. **A GDScript addon cannot
add a row to that table.** It gets `_shortcut_input` (a plain `Node` callback) and has to compare
`InputEvent`s against its own `Shortcut` resources by hand.

Godot 4 does have a command palette:

```gdscript
var command_palette = EditorInterface.get_command_palette()
var command_callable = Callable(self, "external_command").bind(arguments)
command_palette.add_command("command", "test/command", command_callable)
```

`add_command(command_name, key_name, binded_callable, shortcut_text = "None")`. Two consequences of
binding a **Callable**:

1. The command is a live object reference with pre-bound arguments, not a declared id resolved later.
   The target must already exist, so the plugin must be loaded and `_enter_tree()` must have run
   before the command can appear. **There is no lazy activation** — a command cannot be listed while
   its implementation is unloaded. And `remove_command` in `_exit_tree()` is mandatory or the palette
   holds a dangling reference.
2. `shortcut_text` is a **display-only String**. It renders a key hint; it binds nothing.

The internal C++ API is richer and does take a real binding — `ED_SHORTCUT_AND_COMMAND(path, name,
keycode, command)` registers named command, remappable shortcut and palette entry in one call. Engine
code gets that; plugins get the palette entry only.

### 3.5 Undo: command objects

```
void create_action(String name, int merge_mode = 0, Object custom_context = null, bool backward_undo_ops = false)
void add_do_method(Object object, StringName method, ...)
void add_undo_method(Object object, StringName method, ...)
void add_do_property(Object object, StringName property, Variant value)
void add_undo_property(Object object, StringName property, Variant value)
void commit_action(bool execute = true)
```

Obtained via `EditorPlugin.get_undo_redo()`. Which history an action lands in is **deduced from the
first object touched** (a `Node` → the edited scene; an external resource → global history),
overridable with `custom_context`. You spell out the inverse yourself.

---

## 4. Unity editor extensions

### 4.1 `[MenuItem]` — attributes, and a validate function

```csharp
public MenuItem(string itemName);
public MenuItem(string itemName, bool isValidateFunction);
public MenuItem(string itemName, bool isValidateFunction, int priority);
```

> "The MenuItem attribute turns any static function into a menu command. Only static functions can
> use the MenuItem attribute."

Availability is a second static method with the **same path string** and `isValidateFunction: true` —
imperative, like Blender's `poll()`:

```csharp
[MenuItem("MyMenu/Log Selected Transform Name")]
static void LogSelectedTransformName()
{
    Debug.Log("Selected Transform is on " + Selection.activeTransform.gameObject.name + ".");
}

[MenuItem("MyMenu/Log Selected Transform Name", true)]
static bool ValidateLogSelectedTransformName()
{
    return Selection.activeTransform != null;
}
```

Hotkeys are **baked into the path string** — `%` = Ctrl/Cmd, `^` = Ctrl everywhere, `#` = Shift,
`&` = Alt, `_` = no modifier. `[MenuItem("Tools/Do It %#d")]` is Ctrl/Cmd+Shift+D. The binding is a
compile-time string literal with no separate id, and is **not user-remappable**. Priority differences
of 10 or more render a divider.

### 4.2 `[Shortcut]` and the Shortcuts Manager — the real registry

This is the closest thing in any of these systems to an id-declared, remappable, conflict-checked
keymap registry.

```csharp
public ShortcutAttribute(string id, Type context = null);
public ShortcutAttribute(string id, Type context, KeyCode defaultKeyCode, ShortcutModifiers defaultShortcutModifiers = None);
public ShortcutAttribute(string id, Type context, string tag, KeyCode defaultKeyCode, ShortcutModifiers defaultShortcutModifiers = None, int priority);
```

```csharp
[Shortcut("Activate Platform Tool", typeof(SceneView), KeyCode.P)]
static void PlatformToolShortcut()
{
    if (Selection.GetFiltered<Platform>(SelectionMode.TopLevel).Length > 0)
        ToolManager.SetActiveTool<PlatformTool>();
    else
        Debug.Log("No platforms selected!");
}
```

`id` is the stable name (slash-delimited, becomes the category path in the UI); `context` scopes it;
`defaultKeyCode` is **only a default**. `displayName` overrides the label. `ClutchShortcutAttribute`
is the press-and-release variant — the primitive for hold-to-orbit and hold-to-pan.

Three command types: **Action** (fires on press), **Clutch** (fires on press and release), **Menu**
(activates a main-menu option). Bindings live in **profiles**: "You can create multiple profiles and
move between them without restarting the Editor."

**Conflict detection is real, and context-scoped.** A conflict is "when you map a shortcut to
multiple commands that can be executed at the same time" — and "You can assign a single shortcut to
more than one command as long as Unity can't execute the commands at the same time." On assignment
the editor raises a dialog with **Reassign** / **Create Conflict** / **Cancel**, conflicts are
browsable via a **Binding Conflicts** category, and each participant gets a caution icon.

The whole registry is enumerable and mutable at runtime:

```
IShortcutManager:
  activeProfileId           GetAvailableProfileIds()   GetAvailableShortcutIds()
  GetShortcutBinding(id)    RebindShortcut(id, binding)  ClearShortcutOverride(id)
  IsShortcutOverridden(id)  CreateProfile / DeleteProfile / RenameProfile
  events: activeProfileChanged, shortcutBindingChanged
```

### 4.3 Windows, inspectors, viewport tools

`EditorWindow` opened from a `[MenuItem]`; `[CustomEditor]` on an `Editor` subclass for inspectors;
`[EditorTool]` for viewport tools — "A Global tool operates on any selection and remains accessible
from the toolbar. A Component tool functions similarly to CustomEditor, appearing only for selections
matching its target type." `OnToolGUI(EditorWindow)`, `OnActivated()`, `OnWillBeDeactivated()`,
`IsAvailable()`, activated by `ToolManager.SetActiveTool<T>()`.

The canonical example ties all four mechanisms together:

```csharp
[EditorTool("Platform Tool", typeof(Platform))]
class PlatformTool : EditorTool, IDrawSelectedHandles
{
    [Shortcut("Activate Platform Tool", typeof(SceneView), KeyCode.P)]
    static void PlatformToolShortcut() { ... ToolManager.SetActiveTool<PlatformTool>(); }

    public override void OnToolGUI(EditorWindow window)
    {
        ...
        EditorGUI.BeginChangeCheck();
        var start = Handles.PositionHandle(platform.start, Quaternion.identity);
        var end = Handles.PositionHandle(platform.end, Quaternion.identity);
        if (EditorGUI.EndChangeCheck())
        {
            Undo.RecordObject(platform, "Set Platform Destinations");
            platform.start = start;
            platform.end = end;
        }
    }
}
```

### 4.4 The load model: eager attribute scan, no lazy activation

Editor code lives in an Editor-folder or Editor-asmdef assembly, loaded whole into the app domain.
Unity reflects over it for `[MenuItem]`, `[Shortcut]`, `[EditorTool]` and `[CustomEditor]`,
populating menus, the Shortcuts Manager and the tool palette **before any extension code runs**.
Re-scanning happens on **domain reload** — project load, script recompile, and (optionally) entering
Play mode. `[InitializeOnLoad]` is the hook to run code at that moment.

There is no manifest, no per-extension enable/disable, and no per-command activation. Everything is
live the instant the assembly loads. The cost is the domain reload itself, which is why Unity 6
defaults to skipping it on Play mode entry.

### 4.5 Undo: state snapshots

`Undo.RecordObject(obj, name)` before mutating (the system diffs serialised state);
`Undo.RegisterCompleteObjectUndo` for a full copy when the change is not a property delta;
`Undo.RegisterCreatedObjectUndo` / `Undo.DestroyObjectImmediate`; and grouping via
`Undo.GetCurrentGroup()` / `Undo.SetCurrentGroupName(name)` / `Undo.CollapseUndoOperations(group)`.

The contrast with Godot is instructive. Unity: *snapshot* — "record this object, I'm about to change
it." Less code, impossible to get inconsistent, limited to serialisable state. Godot: *command
object* — you spell out the inverse. Works for anything, and it is on you to get the inverse right.
Our `Patch`/`inverse` model in `src/core/commands.ts` is Godot-shaped, but with the inverse derived
mechanically by the applier rather than written by hand.

---

## 5. Photoshop actions and Figma plugins: recorded vs invokable

### 5.1 Photoshop: recording and scripting are the same format

> "An action is a sequence of recorded tasks, such as menu commands, tool operations, and panel
> adjustments, that you can play back on a single file or across multiple files."

Actions save to `.atn` files and load on other machines — the recorded list is a serialisable
artifact, not a program.

**Not everything is recordable.** "For nonrecordable tasks, insert commands from the Actions panel
menu." *Insert Menu Item* stores **only the command identity, with no arguments**: "These commands
run only when the action is played. Playback pauses until you select OK or Cancel if the command
opens a dialog box." That is an *invocation* embedded inside a recording — the invokable/recorded
boundary showing up within one data structure.

**Modal controls** let a recorded step be re-prompted: "You can insert a modal control to pause an
action and change settings for a specific step." The step carries its parameter bundle, so the dialog
opens pre-filled and the user can edit before it runs.

**Recorded values are absolute**, which is the classic failure mode. Adobe's own workaround is a unit
convention: "If you record an action that will be played on files of different sizes, set the ruler
units to percentages."

**The scripting API *is* the action format.** UXP's `batchPlay`:

```javascript
const {app, action, core} = require('photoshop');
async function hideActiveLayer() {
  return await action.batchPlay([{
    _obj: "hide",
    _target: [
      {_ref: "layer", _enum: "ordinal"},
      {_ref: "document", _enum: "ordinal"}
    ]
  }], {});
}
let result = core.executeAsModal(hideActiveLayer, {commandName: "Hide Layer"});
```

`_target` is a **reference form**, never an object pointer — by id, index, name, or ordinal
(`{_ref: "document", _id: 123}`, `{_ref: "document", _name: "Untitled-1"}`). That is precisely what
lets a recorded step run against a document it has never seen. Per-command `_options` include
`dialogOptions` (`"silent"` / `"dontDisplay"` / `"display"`) — the programmatic twin of the modal
toggle: same recorded step, replayed silently or with its dialog.

Recording is just a tap on the same bus: the Actions panel offers **Copy As JavaScript**, and there
is a live listener:

```javascript
action.addNotificationListener(['all'], (event, descriptor) => {
    console.log("Event: " + event + " Descriptor: " + JSON.stringify(descriptor))
});
```

**Mutation requires an exclusive scope.** "A modal state is required when a plugin wants to make
modifications to the Photoshop state… Operations requiring a modal state include creating or
modifying documents" and "only one plugin at a time can use `executeAsModal`". Changes inside collect
into a single history state, committed on return and cancelled on exception, labelled by
`commandName`. This is the direct analogue of our "only the actor holds the write handle", and it is
what makes replaying N steps a single undoable unit.

### 5.2 Figma: declared commands with host-collected parameters

```json
{
  "name": "MyPlugin",
  "id": "737805260747778092",
  "api": "1.0.0",
  "editorType": ["figma", "figjam"],
  "main": "code.js",
  "ui": "ui.html",
  "documentAccess": "dynamic-page",
  "networkAccess": { "allowedDomains": ["none"] }
}
```

`menu` is a declarative command tree:

```json
"menu": [
  { "name": "Create Text", "command": "text" },
  { "name": "Create Frame", "command": "frame" },
  { "separator": true },
  { "name": "Create Shape", "menu": [
      { "name": "Create Circle", "command": "circle" },
      { "separator": true },
      { "name": "Create Rectangle", "command": "rectangle" }
  ]}
]
```

```ts
type ManifestMenuItem =
  { name: string, command: string, parameters?: ParameterList[], parameterOnly?: boolean }
  | { separator: true }
  | { name: string, menu: ManifestMenuItem[] }
```

> "The `command` property is never exposed to the user but is rather exposed to your plugin through
> the `figma.command` javascript property."

The interesting part is `parameters` — **declared as schema, collected by the host**:

```json
"parameters": [
  { "name": "Icon name", "key": "icon-name", "description": "Enter the name of the icon you want to insert." },
  { "name": "Size", "key": "size", "description": "…", "allowFreeform": true },
  { "name": "Color", "key": "color", "description": "…", "allowFreeform": true, "optional": true }
]
```

```ts
interface Parameter { name: string; key: string; description?: string; allowFreeform?: boolean; optional?: boolean }
```

Figma's own quick-action UI collects the values, asking the plugin only for suggestions; for
non-freeform parameters the user cannot proceed without picking one:

```javascript
figma.parameters.on('input', ({ parameters, key, query, result }: ParameterInputEvent) => {
  switch (key) {
    case 'icon':
      const icons = ['menu', 'settings', 'search']
      result.setSuggestions(icons.filter(s => s.includes(query)))
      break
  }
})

figma.on('run', ({ command, parameters }: RunEvent) => {
  switch (command) {
    case "resize":
      handleResize(parameters.width, parameters.height)
      break
  }
})
```

One dispatcher keyed by command string, with a plain-data argument bundle. The plugin never builds
its own argument UI.

`relaunchButtons` / `setRelaunchData` is a saved, re-invokable command pinned to a node:

```json
"relaunchButtons": [
  { "command": "edit", "name": "Edit shape" },
  { "command": "open", "name": "Open Shaper", "multipleSelection": true }
]
```
```ts
node.setRelaunchData({ edit: 'Edit this trapezoid with Shaper', open: '' })
```

Late-bound: what persists is a command **key** plus a description, not an argument bundle — "if the
`command` passed to this method does not match a command in the manifest, nothing will be displayed".
Removing the command from the manifest makes every such button disappear.

**Figma has no user-remappable plugin keybindings** (verified). Plugins are reached from the
Plugins/Tools tab, right-click > Plugins, or quick actions (⌘/); the only plugin-adjacent shortcut is
*Run last plugin* (⌘⌥P).

### 5.3 The distinction

An **invokable** command is a name plus a promise to resolve its arguments at call time against live
context — the selection, the active document, the current units. A **recorded** command is the same
name with its arguments already collapsed to concrete data. Once the arguments are a *value* rather
than a *lookup*, the invocation becomes a thing: appendable, saveable, replayable on another
document, editable step by step, re-orderable, diffable, machine-generated.

What a system needs for its commands to be recordable:

1. **Fully serialisable arguments** — plain typed data. No closures, no callbacks, no "and then ask
   the user".
2. **Identity by stable reference, not pointer** — every target a selector the host can re-resolve.
3. **A single dispatch path** — UI actions must lower to the same command plus arguments the
   scripting path executes, or recording is lossy. *Insert Menu Item* exists precisely because some
   Photoshop menu commands never made it onto that bus.
4. **Declared parameter schemas**, if the host rather than each command is to collect, validate and
   suggest arguments.
5. **An exclusive write scope with undo bracketing**, so replaying N steps is one atomic, named,
   cancellable unit.

And the cost, worth stating plainly: recording freezes *values*, not *intent*. "3 px blur" survives
replay; "blur proportional to the image" does not. The general fix is to make the argument type
expressive enough to carry the relative intent — which is a decision you make *before* you fix a
command's parameters, because afterwards it is whatever you froze.

---

## 6. Comparison

### 6.1 The seven questions

| | **VS Code** | **Blender** | **Godot** | **Unity** | **Photoshop** | **Figma** |
|---|---|---|---|---|---|---|
| **How is a command declared separately from its handler?** | `contributes.commands` in `package.json` (data) → `MenuRegistry`; `registerCommand(id, fn)` at activation → `CommandsRegistry`. Two registries joined by a string. | Class-level `bl_*` metadata + typed property annotations; `execute`/`invoke`/`modal` are the handlers. Same class, but the metadata is registered independently of when the handlers run. | Not separated. `EditorCommandPalette.add_command` binds a live `Callable`. | `[Shortcut(id, …)]` / `[MenuItem(path)]` attribute on the static method. Separated in form (id is a string, scanned off the assembly) but co-located. | `_obj` event id; the handler is Photoshop itself. Fully separated — the descriptor is data. | `manifest.json` `menu: [{name, command}]` (data) → one `figma.on('run')` dispatcher keyed by command string. |
| **What does the declaration carry?** | `command`, `title`, `shortTitle`, `category`, `enablement` (a when-expr), `icon` | `bl_idname`, `bl_label`, `bl_description`, `bl_options` (undo/register/internal policy), `bl_undo_group`, plus the full typed property schema | `command_name`, `key_name`, the Callable, display-only `shortcut_text` | `id`, `context` type, `tag`, default key, `priority`, `displayName` | event id + typed argument descriptor | `name`, `command`, optional declared `parameters` schema, `parameterOnly` |
| **How is availability computed? Declarative or imperative?** | **Declarative.** `enablement` / `when` — a parsed, pure, synchronous expression over a context-key namespace. Consumers get `keys()` for targeted invalidation. | **Imperative.** `poll(cls, context)` — arbitrary Python. Re-run on every layout pass and every search keystroke. `poll_message_set` supplies the reason. | `_handles(object)` — imperative, and derived from *selection type*, not tool state. | **Imperative.** A second static method with the same menu path and `validate: true`; `EditorTool.IsAvailable()`. Shortcut *scope* is declarative (`context` type). | n/a — `commandEnablement` option per step | n/a |
| **How are keybinding conflicts detected and resolved?** | **Not detected.** Ordered list, reverse scan, first context-match wins; user file appended last. Duplicates are *the layering mechanism*. "Show Same Keybindings" is a search filter. Removal rules match by `when`-implication. | **Not detected**, and undetectable in principle (poll is arbitrary code). Ordered list, first match wins; `head=True` and `kmi.active=False` are the only levers. `poll()` failing falls through to the next item. | **Not detected.** No registry for plugin shortcuts at all. | **Detected**, context-scoped: "a single shortcut [on] more than one command as long as Unity can't execute [them] at the same time". Reassign / Create Conflict / Cancel dialog, Binding Conflicts view. | n/a | n/a — no plugin keybindings |
| **What does a keybinding bind to?** | A **command id string + one optional `args` value**. Never a function. Same id bindable N times with N `args`. | An **operator idname string + a property bundle** (`kmi.properties`). Same operator bound N times with N bundles. | Nothing — plugin shortcuts are hand-rolled `InputEvent` comparisons. Engine-internal: a path id via `ED_SHORTCUT`. | A **shortcut id string**; the default key is only a default, overrides live in a switchable profile. | n/a | n/a |
| **How does a test invoke a command?** | `await vscode.commands.executeCommand<T>(id, ...args)` — same path as the keybinding. | `bpy.ops.mesh.subdivide(number_cuts=3)`, optionally `'EXEC_DEFAULT'` / `'INVOKE_DEFAULT'`. **Provably the same call**: keymap and Python both land in `wm_operator_invoke`. | Call the `Callable`. | Call the static method, or `ShortcutManager` APIs for binding state. | `batchPlay([descriptor], {})` — literally the recorded format. | `figma.on('run')` with a `{command, parameters}` payload. |
| **What does an extension contribute, and when is it loaded?** | Declarations from the manifest at **parse time**; handlers at **activation**, triggered by `onCommand:<id>` (auto-generated since 1.74). Commands are enumerable while the handler is unloaded. | Registration at add-on enable; `register()` adds classes and keymap items, `unregister()` removes them. Eager. | `plugin.cfg` is **identity only, zero contribution data**. Everything registered imperatively in `_enter_tree()`, every `add_*` needing a matching `remove_*`. Per-project opt-in; genuinely dynamic. | No manifest. Attributes **scanned off the assembly at domain reload**, before any extension code runs. No per-command activation, no enable/disable. | n/a | Manifest declares `menu` and `parameters`; the plugin is loaded when run. |
| **How are command arguments typed or validated?** | `ICommandMetadata.args[].constraint` (`typeof` string, class, or arity-1 predicate), enforced by a wrapper around the handler. `schema` is docs-only. **Not available to extensions** — extension commands get none. | `bpy.props` — a real typed schema with `min`/`max` (silent clamp), `soft_min`/`soft_max` (UI drag limits), `subtype`, `unit`, enum items. Drives UI, tooltip, keymap args, docs and call signature from one declaration. **No object arguments.** | Untyped `Variant` args pre-bound into the Callable. | C# method signature; `ShortcutArguments` for clutch state. | Typed `ActionDescriptor` values; targets are **reference forms** (`_ref` by id/index/name/ordinal), never pointers. | Declared `parameters` with `key`, `optional`, `allowFreeform`; **host-collected** via the quick-action UI with plugin-supplied suggestions. |

### 6.2 Load model, at a glance

| | Declaration visible before handler loads? | Trigger to load the handler |
|---|---|---|
| VS Code | **Yes** — manifest parse populates the palette | `onCommand:<id>`, auto-generated from `contributes.commands` |
| Blender | No — `register()` must have run | add-on enable |
| Godot | No — the palette holds a live `Callable` | plugin enable (`_enter_tree()`) |
| Unity | No, but effectively yes — attributes are scanned before any extension code runs | domain reload (eager, whole-assembly) |
| Figma | **Yes** — `menu` is manifest data | user runs the command |

### 6.3 Undo model, at a glance

| | Model | Granularity control |
|---|---|---|
| Blender | Registry **policy flag** (`bl_options={'REGISTER','UNDO'}`); the system pushes on `{'FINISHED'}` | `op_undo_depth` nesting guard (composition = one step); `'UNDO_GROUPED'` + `bl_undo_group` to coalesce repeats |
| Godot | **Command objects** — `create_action` / `add_do_method` / `add_undo_method` / `commit_action`; you write the inverse | one action per `create_action`; history chosen by first object touched |
| Unity | **State snapshots** — `Undo.RecordObject(obj, name)` before mutating | `SetCurrentGroupName` + `CollapseUndoOperations(group)` |
| Photoshop | **Exclusive modal scope** — `executeAsModal(fn, {commandName})` brackets all mutation into one named history state | the scope is the unit |
| papercut today | Patches with a **mechanically derived** inverse (`applyPatch` reads the previous value as it writes) | one `{label, patches, inverse}` per commit; compaction planned in the stroke actor |

---

## 7. What to steal, what to avoid

**Everything in this section is my opinion, not a finding.** The sections above are sourced; this one
is a recommendation, and the later prototype tickets should feel free to overrule it.

### Steal

**1. Two registries, joined only by a string id.** This is the one non-negotiable. A *declaration*
registry holding pure data (id, title, category, availability expression, argument schema, icon), and
a *handler* registry that an actor populates when it starts. VS Code's split is the reference, and it
is exactly what the map asks for: "the declaration is enumerable even when the handling actor is not
currently running." A keybinding UI and a command palette read the declaration registry, which is
static and complete at module-load time. Dispatch consults the handler registry. The two failure
modes are both meaningful: declared-not-handled is "this command exists but its actor is not running"
(a user-facing message, not a crash), and handled-not-declared is an internal command.

**2. Bind to `(command id, args)`, never to a function.** Universally true across VS Code
(`command` + `args`), Blender (`idname` + `kmi.properties`), and Unity (`id`). Godot is the
counterexample — binding a `Callable` is exactly what forces its palette to require the plugin be
loaded, and it is the reason Godot has no lazy anything. The payoff is compounding: bindings become
inert, serialisable, user-editable data; `args` collapses the command surface dramatically (one
`camera.orbit` with `{axis, dir}` beats four commands); and the same `(id, args)` tuple becomes the
keymap entry, the menu button's payload, and — per §5 — a recordable step, for free.

**3. Declarative availability, with an explicit reason.** This is the sharpest fork in the road.
Blender's `poll()` is more expressive and strictly worse: unqueryable, unanalysable, re-run on every
layout pass, and conflict detection is *impossible in principle* because you cannot prove two
arbitrary predicates disjoint. VS Code's `when` is a pure, synchronous, parsed expression over a
context-key namespace, and `keys()` makes targeted invalidation possible. Take the VS Code shape but
do it better in one respect: Blender's `poll_message_set` is the right idea bolted on a decade late
and still sparsely used. **Make the "why not" mandatory from day one** — a disabled tool button that
cannot say why is a support ticket. It is cheap now and unretrofittable later.

Our shape should be a small typed predicate DSL, not strings: VS Code's own internals avoid the
stringly-typed version with `RawContextKey`, which *is* an expression and composes without a string
round-trip. In TypeScript we can do better than either — a `ContextKey<T>` object with
`.is(v)`/`.not()` and `and`/`or` combinators, `.keys()` for invalidation, and a serialiser for the
preferences file. Note the asymmetry that makes it work: **imperative write, declarative read.**
Producers of context never know their consumers.

**4. `when` as a match predicate, not a post-selection guard.** The single most consequential line in
all of this research is `continue` rather than `return null` in VS Code's `_findCommand` — and Blender
arrived at the same behaviour by a different route (a failing `poll` yields `PASS_THROUGH` →
`WM_HANDLER_CONTINUE`). Both systems independently concluded that a higher-priority binding whose
condition is false must **fall through**, not swallow the key. Get this backwards and every
tool-specific binding becomes a black hole. It also gives us the `f5`-continue/`f5`-start idiom for
free, which is exactly how a modal tool should layer over a global default.

**5. One typed argument schema, feeding everything.** Blender's `bpy.props` is the crown jewel of that
system and the piece I would most like to reproduce: one declaration becomes the auto-generated
parameter UI, the tooltip, the keymap's stored args, the preset format, and the scripted call
signature. We are already committed to Zod and Ajv, and brief §13 already requires a JSON Schema →
form renderer. **The command argument schema should be the same machinery.** That turns the "Adjust
Last Operation" panel from a feature into a consequence — Blender's F9 redo is not a separate system,
it is "pop the step, re-run `execute()` on the retained instance with new property values", and it
falls straight out of having typed args on a retained record.

Figma's variant is worth folding in: **declare the parameters, let the host collect them.** A command
palette that can prompt for a brush radius, with plugin-supplied suggestions, is strictly better than
Blender's, whose search cannot pass arguments at all (`WM_operator_name_call_ptr(..., nullptr,
nullptr)`).

**6. Ordered list, reverse scan, user bindings appended last.** No specificity scoring, no
"most-specific-wins" heuristic, no resolution pass. Trivially explainable, trivially debuggable, and
user overrides are literally "appended last". Copy `KeybindingWeight` as a small enum
(`core` < `tool` < `feature-module` < `user`).

**7. Distinguish unbind from shadow, and match unbinds by implication.** Removal deletes the rule so
lower rules become reachable; empty-command shadows it so the key is consumed and does nothing. Users
will want both. And match removals by `when`-implication rather than equality — VS Code does this
specifically so a user's unbind survives us tightening a default's condition in a later release. It
is a few lines and it prevents an upgrade-regression class that is invisible until people complain.

**8. Precondition (capability) separate from `when` (scope), ANDed mechanically.** VS Code's
`registerAction2` is the single best declaration API in this survey: one `super({...})` call fans out
to command registry, keybindings, menus and palette, with `precondition` silently conjoined into each
surface's condition. That keeps four registrations from drifting, and the correct fall-through
behaviour for disabled commands is *emergent*, not special-cased. The three-layer example is worth
memorising as a shape: capability (`writable && hasFormatter`), scope (`editorTextFocus`), surface
(`hasNonEmptySelection`).

**9. Chord state in the service, resolver pure.** `resolve(context, currentChords, keypress)` as a
pure function is exhaustively unit-testable; the stateful parts (timeout, focus-loss bail, status
message) live in one place outside it. We want this for a different reason than VS Code does: a pure
resolver is testable without a DOM, which matters for a dispatch layer that must be driveable from a
test.

**10. Ambient scope resolved from the focused element.** VS Code's `data-keybinding-context` +
walk-up-to-nearest-scope answers "which panel is this key for?" from the event target rather than a
hand-maintained focus state machine. For a viewport-plus-panels editor this is very likely right, and
it composes with React's tree naturally. Note this is *not* document state and *not* machine context
— it is a third thing, and it should stay a third thing.

**11. Undo as a registry-level policy, with a nesting guard.** We already have the better half of
this: `applyPatch` derives the inverse mechanically, so no tool writes an `undo()` method — strictly
better than Godot's hand-written `add_undo_method`. What we should take from Blender is the
**`op_undo_depth` nesting guard**: a command that dispatches other commands must produce *one* undo
entry, not N. That question is listed as open in the map ("Undo granularity across actors"); this is
the mechanism. Blender's `'UNDO_GROUPED'` + `bl_undo_group` is also the right shape for coalescing a
repeated nudge, and it is orthogonal to the stroke compaction already planned in `docs/stack.md`.

**12. Design for recordability now, even though recording is out of scope.** The five prerequisites in
§5.3 are all cheap at design time and expensive later. We are already most of the way there —
`Patch` is addressed by stable selectors (`{t:'terrain', field, index}`, `{t:'object', id}`), not by
object identity, which is precisely Photoshop's `_ref` discipline. The rule to write down: **command
arguments must be plain serialisable data addressing targets by stable id, never object references or
closures.** If that holds, a macro system, a scriptable test harness, and a `.json` of reproducible
edits all become possible without re-architecting. Photoshop's *Insert Menu Item* exists precisely
because some of its menu commands never made it onto the descriptor bus — that is the failure to
avoid.

### Avoid

**1. Godot's Callable-bound palette.** Binding a live object reference with pre-bound arguments makes
lazy declaration impossible by construction, requires `remove_command` discipline to avoid dangling
references, and reduces the shortcut to a display-only string. It is the single clearest
counterexample in this survey, and the map's requirement — declarations enumerable while the actor is
not running — rules it out directly.

**2. Blender's context-instead-of-arguments.** *"Can't pass data such as objects, meshes or materials
to operate on (operators use the context instead)"* is Blender's own docs listing its own worst
design decision, and `context.temp_override(**overrides)` is the scar tissue. **Our commands should
take explicit targets.** `objects.delete({ ids })`, not `objects.delete()` acting on ambient
selection. Ambient context is fine for *availability*; it is poison for *arguments*. This also falls
out of the recordability rule above — an ambient argument cannot be recorded.

**3. Sticky arguments by default.** Blender persists the last-used value of every operator property
and re-seeds the next invocation, requiring per-property `SKIP_SAVE` to opt out. Invisible, surprising,
and the wrong default. If we want persistence, make it opt-in and explicit.

**4. Silent clamping as the only validation.** Blender's hard `min`/`max` silently coerce. Our Zod
schemas should *reject* and report, then let the call site decide whether to clamp. A scripted call
that quietly did something other than what it said is worse than one that failed.

**5. Identifier discoverability behind a preference.** Blender puts Operator Search and Python
Tooltips behind two off-by-default settings while requiring raw idnames to configure a keybinding.
Command ids should be visible in the keybinding UI and the palette by default.

**6. Unity's hotkey-in-the-menu-string.** `[MenuItem("Tools/Do It %#d")]` bakes the binding into the
identifier, with no separate id and no remapping. Unity itself replaced this with
`ShortcutManagement` — take the replacement, not the original.

**7. An eager whole-assembly scan as the only load model.** Unity's domain reload is why Unity 6
defaults to skipping it on Play-mode entry. In-tree feature modules mean we can afford eager
registration of *declarations* at module load; what we should preserve is the ability to keep the
*handlers* lazy, which is what VS Code's split buys and what the map's "declaration enumerable when
the actor is not running" already demands.

**8. Blender's argument-less search.** A palette that can only run defaults throws away most of the
value of a typed schema. If we have declared parameters, the palette should collect them — Figma's
model, and it is not much more work than the list.

### Two open questions this research does not settle

- **Do conflicts warn?** VS Code deliberately does not (duplicates are the layering mechanism); Unity
  does, context-scoped, with Reassign / Create Conflict / Cancel. Both work. The difference is that
  Unity's contexts are a closed set of types, while VS Code's `when` clauses are arbitrary
  expressions — so Unity *can* decide "these two can never fire together" and VS Code cannot. If our
  availability predicates are a small DSL (recommendation 3), we get Unity's option. Whether to use
  it is a real decision, and `docs/stack.md` currently lists "conflict detection" as a requirement of
  the keymap registry, which points at Unity.
- **Does a keybinding carry `args`, or do we mint one command per variant?** `args` is what every
  mature system converged on, but it interacts with the argument schema (`args` must validate against
  it) and with conflict detection (two bindings to the same id with different args are not a
  conflict). Worth prototyping.
