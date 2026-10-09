/**
 * Every source file the phone's bundle reaches, found by following its imports.
 *
 * The phone app is the desktop's renderer and business layer over a second
 * `window.wta` (`mobile/src/bridge`), so most of `src/main` ships in the APK
 * too. A WebView has neither Node nor Electron: a module the phone reaches
 * must not import either, nor read Node's globals as it loads. 2.0.11 nearly
 * shipped a blank phone screen because `identity.ts`, reached through
 * `tmdb.ts`, read `process.versions` unguarded.
 *
 * Which modules those are is not a list anyone keeps. It is worked out here,
 * from the imports themselves, starting at the phone's entry point, so the
 * set grows the moment the bridge imports another `@main/*` module, and with
 * everything that module imports in turn. `eslint.config.js` puts the
 * boundary rules on exactly this set, and `mobile/src/boundary.test.ts` loads
 * every module in it without a `process`.
 *
 * ## What counts as an import
 *
 * Whatever is still there at run time. `import type …` and `export type …`
 * are erased by the build, so they are not followed: `identity.ts` names
 * Electron's `Session` type and still runs on the phone. Everything else is,
 * including `import { type A } from …`, which `verbatimModuleSyntax` keeps as
 * an import of the module for its side effects, and `import()` with a literal
 * path. A `.svelte` file's imports are read from its `<script>` blocks.
 *
 * Plain JavaScript, not TypeScript, because ESLint loads it while reading its
 * own configuration, before anything could compile it. `phonereach.d.ts`
 * describes it to the test that imports it.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

/** Where the phone's build starts: `mobile/index.html` loads only this. */
export const PHONE_ENTRY = 'mobile/src/main.ts'

/**
 * The phone build's aliases (`mobile/vite.config.ts`), as directories under
 * the repository root. An import through an alias missing here stops the
 * walk with an error rather than being taken for a package.
 */
const ALIASES = [
  ['@shared/', 'src/shared/'],
  ['@main/', 'src/main/'],
  ['@/', 'src/renderer/src/'],
]

/** What an import names, tried in this order, as Vite resolves it. */
const SUFFIXES = ['', '.ts', '/index.ts']

/** Only these are read for imports; a stylesheet or JSON file has none to follow. */
const CODE = /\.(ts|svelte)$/

/**
 * @param {string} root the repository's root directory
 * @param {string[]} [entries] where to start, relative to `root`; the phone's entry point unless given
 * @returns {import('./phonereach').PhoneReach}
 */
export function phoneReach(root, entries = [PHONE_ENTRY]) {
  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {Map<string, Set<string>>} */
  const packages = new Map()
  const queue = entries.map((entry) => resolve(root, entry))

  while (queue.length > 0) {
    const file = /** @type {string} */ (queue.pop())
    if (seen.has(file)) continue
    seen.add(file)
    if (!CODE.test(file)) continue

    for (const specifier of runtimeImports(file)) {
      const local = localTarget(root, file, specifier)
      if (local === null) {
        // A bare name that is not installed is most likely an alias this
        // file does not know, whose modules would go unchecked.
        if (!isPackage(root, specifier)) {
          throw new Error(
            `phonereach: '${specifier}' imported by ${relative(root, file)} is neither an alias listed here nor an installed package`,
          )
        }
        const importers = packages.get(specifier) ?? new Set()
        importers.add(posix(relative(root, file)))
        packages.set(specifier, importers)
        continue
      }
      const target = SUFFIXES.map((suffix) => local + suffix).find(isFile)
      // An import the build would fail on: say so, rather than quietly
      // leaving whatever is behind it out of the set the boundary covers.
      if (target === undefined) {
        throw new Error(
          `phonereach: cannot resolve '${specifier}' imported by ${relative(root, file)}`,
        )
      }
      queue.push(target)
    }
  }

  return {
    files: [...seen]
      .filter((file) => CODE.test(file))
      .map((file) => posix(relative(root, file)))
      .sort(),
    packages: new Map([...packages].map(([name, importers]) => [name, [...importers].sort()])),
  }
}

/**
 * The path an import names in this repository, without its extension, or
 * null when it names a package.
 *
 * @param {string} root
 * @param {string} from the importing file
 * @param {string} specifier
 * @returns {string | null}
 */
function localTarget(root, from, specifier) {
  // A query (`?raw`, `?url`) asks Vite for a form of the same file.
  const path = specifier.split('?')[0]
  for (const [alias, directory] of ALIASES) {
    if (path.startsWith(alias)) return resolve(root, directory, path.slice(alias.length))
  }
  if (path.startsWith('.')) return resolve(dirname(from), path)
  return null
}

/**
 * Every module a file imports at run time. See "What counts as an import".
 *
 * @param {string} file
 * @returns {string[]}
 */
function runtimeImports(file) {
  const text = readFileSync(file, 'utf8')
  const scripts = file.endsWith('.svelte')
    ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1])
    : [text]

  /** @type {string[]} */
  const found = []
  for (const script of scripts) {
    const source = ts.createSourceFile(
      file,
      script,
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.TS,
    )
    /** @param {import('typescript').Node} node */
    const visit = (node) => {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
        found.push(/** @type {import('typescript').StringLiteral} */ (node.moduleSpecifier).text)
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
        found.push(/** @type {import('typescript').StringLiteral} */ (node.moduleSpecifier).text)
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        found.push(node.arguments[0].text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return found
}

/**
 * Whether a bare import names something there to import: one of Node's
 * modules, or an installed package (`svelte/transition` is `svelte`'s).
 *
 * @param {string} root
 * @param {string} specifier
 */
function isPackage(root, specifier) {
  if (specifier.startsWith('node:') || builtinModules.includes(specifier)) return true
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  return existsSync(resolve(root, 'node_modules', name))
}

/** @param {string} path */
function isFile(path) {
  return existsSync(path) && statSync(path).isFile()
}

/**
 * ESLint's `files` patterns and the test's messages use `/`, on Windows too.
 *
 * @param {string} path
 */
function posix(path) {
  return path.split(sep).join('/')
}
