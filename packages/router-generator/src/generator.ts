import path from 'path'
import * as fs from 'fs/promises'
import * as prettier from 'prettier'
import { Config } from './config'
import { cleanPath, trimPathLeft } from './utils'

let latestTask = 0
export const rootPathId = '__root'

export type RouteNode = {
  filePath: string
  fullPath: string
  variableName: string
  routePath?: string
  cleanedPath?: string
  path?: string
  isNonPath?: boolean
  isNonLayout?: boolean
  isRoute?: boolean
  isLoader?: boolean
  isComponent?: boolean
  isErrorComponent?: boolean
  isPendingComponent?: boolean
  isNotFoundComponent?: boolean
  isVirtual?: boolean
  isRoot?: boolean
  children?: RouteNode[]
  parent?: RouteNode
}

async function getRouteNodes(config: Config) {
  const { routeFilePrefix, routeFileIgnorePrefix } = config

  let routeNodes: RouteNode[] = []

  async function recurse(dir: string) {
    const fullDir = path.resolve(config.routesDirectory, dir)
    let dirList = await fs.readdir(fullDir, { withFileTypes: true })

    dirList = dirList.filter((d) => {
      if (
        d.name.startsWith('.') ||
        (routeFileIgnorePrefix && d.name.startsWith(routeFileIgnorePrefix))
      ) {
        return false
      }

      if (routeFilePrefix) {
        return d.name.startsWith(routeFilePrefix)
      }

      return true
    })

    await Promise.all(
      dirList.map(async (dirent) => {
        const fullPath = path.join(fullDir, dirent.name)
        const relativePath = path.join(dir, dirent.name)

        if (dirent.isDirectory()) {
          await recurse(relativePath)
        } else if (fullPath.match(/\.(tsx|ts|jsx|js)$/)) {
          const filePath = replaceBackslash(path.join(dir, dirent.name))
          const filePathNoExt = removeExt(filePath)
          let routePath =
            cleanPath(`/${filePathNoExt.split('.').join('/')}`) || ''
          const variableName = routePathToVariable(routePath)

          // Remove the index from the route path and
          // if the route path is empty, use `/'

          let isRoute = routePath?.endsWith('/route')
          let isComponent = routePath?.endsWith('/component')
          let isErrorComponent = routePath?.endsWith('/errorComponent')
          let isPendingComponent = routePath?.endsWith('/pendingComponent')
          let isNotFoundComponent = routePath?.endsWith('/notFoundComponent')
          let isLoader = routePath?.endsWith('/loader')

          routePath = routePath?.replace(
            /\/(component|errorComponent|pendingComponent|notFoundComponent|loader|route)$/,
            '',
          )

          if (routePath === 'index') {
            routePath = '/'
          }

          routePath = routePath.replace(/\/index$/, '/') || '/'

          routeNodes.push({
            filePath,
            fullPath,
            routePath,
            variableName,
            isRoute,
            isComponent,
            isErrorComponent,
            isPendingComponent,
            isNotFoundComponent,
            isLoader,
          })
        }
      }),
    )

    return routeNodes
  }

  await recurse('./')

  return routeNodes
}

let first = false
let skipMessage = false

type RouteSubNode = {
  component?: RouteNode
  errorComponent?: RouteNode
  pendingComponent?: RouteNode
  notFoundComponent?: RouteNode
  loader?: RouteNode
}

export async function generator(config: Config) {
  console.log()

  if (!first) {
    console.log('🔄 Generating routes...')
    first = true
  } else if (skipMessage) {
    skipMessage = false
  } else {
    console.log('♻️  Regenerating routes...')
  }

  const taskId = latestTask + 1
  latestTask = taskId

  const checkLatest = () => {
    if (latestTask !== taskId) {
      skipMessage = true
      return false
    }

    return true
  }

  const start = Date.now()
  const routePathIdPrefix = config.routeFilePrefix ?? ''

  const preRouteNodes = multiSortBy(await getRouteNodes(config), [
    (d) => (d.routePath === '/' ? -1 : 1),
    (d) => d.routePath?.split('/').length,
    (d) => (d.filePath?.match(/[./]index[.]/) ? 1 : -1),
    (d) =>
      d.filePath?.match(
        /[./](component|errorComponent|pendingComponent|notFoundComponent|loader)[.]/,
      )
        ? 1
        : -1,
    (d) => (d.filePath?.match(/[./]route[.]/) ? -1 : 1),
    (d) => (d.routePath?.endsWith('/') ? -1 : 1),
    (d) => d.routePath,
  ]).filter(
    (d) => ![`/${routePathIdPrefix + rootPathId}`].includes(d.routePath || ''),
  )

  const routeTree: RouteNode[] = []
  const routePiecesByPath: Record<string, RouteSubNode> = {}

  // Loop over the flat list of routeNodes and
  // build up a tree based on the routeNodes' routePath
  let routeNodes: RouteNode[] = []

  const handleNode = (node: RouteNode) => {
    const parentRoute = hasParentRoute(routeNodes, node.routePath)
    if (parentRoute) node.parent = parentRoute

    node.path = node.parent
      ? node.routePath?.replace(node.parent.routePath!, '') || '/'
      : node.routePath

    const trimmedPath = trimPathLeft(node.path ?? '')

    const split = trimmedPath?.split('/') ?? []
    let first = split[0] ?? trimmedPath ?? ''

    node.isNonPath = first.startsWith('_')
    node.isNonLayout = first.endsWith('_')

    node.cleanedPath = removeUnderscores(node.path) ?? ''

    console.log(node)
    if (
      !node.isVirtual &&
      (node.isLoader ||
        node.isComponent ||
        node.isErrorComponent ||
        node.isPendingComponent ||
        node.isNotFoundComponent)
    ) {
      routePiecesByPath[node.routePath!] =
        routePiecesByPath[node.routePath!] || {}

      routePiecesByPath[node.routePath!]![
        node.isLoader
          ? 'loader'
          : node.isErrorComponent
            ? 'errorComponent'
            : node.isPendingComponent
              ? 'pendingComponent'
              : node.isNotFoundComponent
                ? 'notFoundComponent'
                : 'component'
      ] = node

      const anchorRoute = routeNodes.find((d) => d.routePath === node.routePath)

      if (!anchorRoute) {
        handleNode({
          ...node,
          isVirtual: true,
          isLoader: false,
          isComponent: false,
          isErrorComponent: false,
          isPendingComponent: false,
          isNotFoundComponent: false,
        })
      }
      return
    }

    if (node.parent) {
      node.parent.children = node.parent.children ?? []
      node.parent.children.push(node)
    } else {
      routeTree.push(node)
    }

    routeNodes.push(node)
  }

  preRouteNodes.forEach((node) => handleNode(node))

  async function buildRouteConfig(
    nodes: RouteNode[],
    depth = 1,
  ): Promise<string> {
    const children = nodes.map(async (node) => {
      const routeCode = await fs.readFile(node.fullPath, 'utf-8')

      // Ensure the boilerplate for the route exists
      if (node.isRoot) {
        return
      }

      // Ensure that new FileRoute(anything?) is replaced with FileRoute(${node.routePath})
      // routePath can contain $ characters, which have special meaning when used in replace
      // so we have to escape it by turning all $ into $$. But since we do it through a replace call
      // we have to double escape it into $$$$. For more information, see
      // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/replace#specifying_a_string_as_the_replacement
      const escapedRoutePath = removeTrailingUnderscores(
        node.routePath?.replaceAll('$', '$$') ?? '',
      )
      const quote = config.quoteStyle === 'single' ? `'` : `"`
      const replaced = routeCode.replace(
        /(FileRoute\(\s*['"])([^\s]+)(['"](?:,?)\s*\))/g,
        (match, p1, p2, p3) => `${p1}${escapedRoutePath}${p3}`,
      )

      if (replaced !== routeCode) {
        await fs.writeFile(node.fullPath, replaced)
      }

      const route = `${node.variableName}Route`

      if (node.children?.length) {
        const childConfigs = await buildRouteConfig(node.children, depth + 1)
        return `${route}.addChildren([${spaces(depth * 4)}${childConfigs}])`
      }

      return route
    })

    return (await Promise.all(children)).filter(Boolean).join(`,`)
  }

  const routeConfigChildrenText = await buildRouteConfig(routeTree)

  const sortedRouteNodes = multiSortBy(routeNodes, [
    (d) =>
      d.routePath?.includes(`/${routePathIdPrefix + rootPathId}`) ? -1 : 1,
    (d) => d.routePath?.split('/').length,
    (d) => (d.routePath?.endsWith("index'") ? -1 : 1),
    (d) => d,
  ])

  const imports = Object.entries({
    FileRoute: sortedRouteNodes.some((d) => d.isVirtual),
    lazyFn: sortedRouteNodes.some(
      (node) => routePiecesByPath[node.routePath!]?.loader,
    ),
    lazyRouteComponent: sortedRouteNodes.some(
      (node) =>
        routePiecesByPath[node.routePath!]?.component ||
        routePiecesByPath[node.routePath!]?.errorComponent ||
        routePiecesByPath[node.routePath!]?.pendingComponent ||
        routePiecesByPath[node.routePath!]?.notFoundComponent,
    ),
  })
    .filter((d) => d[1])
    .map((d) => d[0])

  const virtualRouteNodes = sortedRouteNodes.filter((d) => d.isVirtual)

  const routeImports = [
    '// This file is auto-generated by TanStack Router',
    imports.length
      ? `import { ${imports.join(', ')} } from '@tanstack/react-router'\n`
      : '',
    '// Import Routes',
    [
      `import { Route as rootRoute } from './${replaceBackslash(
        path.relative(
          path.dirname(config.generatedRouteTree),
          path.resolve(config.routesDirectory, routePathIdPrefix + rootPathId),
        ),
      )}'`,
      ...sortedRouteNodes
        .filter((d) => !d.isVirtual)
        .map((node) => {
          return `import { Route as ${
            node.variableName
          }Import } from './${replaceBackslash(
            removeExt(
              path.relative(
                path.dirname(config.generatedRouteTree),
                path.resolve(config.routesDirectory, node.filePath),
              ),
            ),
          )}'`
        }),
    ].join('\n'),
    virtualRouteNodes.length ? '// Create Virtual Routes' : '',
    virtualRouteNodes
      .map((node) => {
        return `const ${
          node.variableName
        }Import = new FileRoute('${removeTrailingUnderscores(
          node.routePath,
        )}').createRoute()`
      })
      .join('\n'),
    '// Create/Update Routes',
    sortedRouteNodes
      .map((node) => {
        const loaderNode = routePiecesByPath[node.routePath!]?.loader
        const componentNode = routePiecesByPath[node.routePath!]?.component
        const errorComponentNode =
          routePiecesByPath[node.routePath!]?.errorComponent
        const pendingComponentNode =
          routePiecesByPath[node.routePath!]?.pendingComponent
        const notFoundComponentNode =
          routePiecesByPath[node.routePath!]?.notFoundComponent

        return [
          `const ${node.variableName}Route = ${node.variableName}Import.update({
          ${[
            node.isNonPath
              ? `id: '${node.path}'`
              : `path: '${node.cleanedPath}'`,
            `getParentRoute: () => ${node.parent?.variableName ?? 'root'}Route`,
          ]
            .filter(Boolean)
            .join(',')}
        }${config.disableTypes ? '' : 'as any'})`,
          loaderNode
            ? `.updateLoader({ loader: lazyFn(() => import('./${replaceBackslash(
                removeExt(
                  path.relative(
                    path.dirname(config.generatedRouteTree),
                    path.resolve(config.routesDirectory, loaderNode.filePath),
                  ),
                ),
              )}'), 'loader') })`
            : '',
          componentNode ||
          errorComponentNode ||
          pendingComponentNode ||
          notFoundComponentNode
            ? `.update({
              ${(
                [
                  ['component', componentNode],
                  ['errorComponent', errorComponentNode],
                  ['pendingComponent', pendingComponentNode],
                  ['notFoundComponent', notFoundComponentNode],
                ] as const
              )
                .filter((d) => d[1])
                .map((d) => {
                  return `${
                    d[0]
                  }: lazyRouteComponent(() => import('./${replaceBackslash(
                    removeExt(
                      path.relative(
                        path.dirname(config.generatedRouteTree),
                        path.resolve(config.routesDirectory, d[1]!.filePath),
                      ),
                    ),
                  )}'), '${d[0]}')`
                })
                .join('\n,')}
            })`
            : '',
        ].join('')
      })
      .join('\n\n'),
    ...(config.disableTypes
      ? []
      : [
          '// Populate the FileRoutesByPath interface',
          `declare module '@tanstack/react-router' {
  interface FileRoutesByPath {
    ${routeNodes
      .map((routeNode) => {
        return `'${removeTrailingUnderscores(routeNode.routePath)}': {
          preLoaderRoute: typeof ${routeNode.variableName}Import
          parentRoute: typeof ${
            routeNode.parent?.variableName
              ? `${routeNode.parent?.variableName}Import`
              : 'rootRoute'
          }
        }`
      })
      .join('\n')}
  }
}`,
        ]),
    '// Create and export the route tree',
    `export const routeTree = rootRoute.addChildren([${routeConfigChildrenText}])`,
  ]
    .filter(Boolean)
    .join('\n\n')

  const routeConfigFileContent = await prettier.format(routeImports, {
    semi: false,
    singleQuote: config.quoteStyle === 'single',
    parser: 'typescript',
  })

  const routeTreeContent = await fs
    .readFile(path.resolve(config.generatedRouteTree), 'utf-8')
    .catch((err: any) => {
      if (err.code === 'ENOENT') {
        return undefined
      }
      throw err
    })

  if (!checkLatest()) return

  if (routeTreeContent !== routeConfigFileContent) {
    await fs.mkdir(path.dirname(path.resolve(config.generatedRouteTree)), {
      recursive: true,
    })
    if (!checkLatest()) return
    await fs.writeFile(
      path.resolve(config.generatedRouteTree),
      routeConfigFileContent,
    )
  }

  console.log(
    `🌲 Processed ${routeNodes.length} routes in ${Date.now() - start}ms`,
  )
}

function routePathToVariable(d: string): string {
  return (
    removeUnderscores(d)
      ?.replace(/\/\$\//g, '/splat/')
      ?.replace(/\$$/g, 'splat')
      ?.replace(/\$/g, '')
      ?.split(/[/-]/g)
      .map((d, i) => (i > 0 ? capitalize(d) : d))
      .join('')
      .replace(/([^a-zA-Z0-9]|[\.])/gm, '') ?? ''
  )
}

export function removeExt(d: string) {
  return d.substring(0, d.lastIndexOf('.')) || d
}

function spaces(d: number): string {
  return Array.from({ length: d })
    .map(() => ' ')
    .join('')
}

export function multiSortBy<T>(
  arr: T[],
  accessors: ((item: T) => any)[] = [(d) => d],
): T[] {
  return arr
    .map((d, i) => [d, i] as const)
    .sort(([a, ai], [b, bi]) => {
      for (const accessor of accessors) {
        const ao = accessor(a)
        const bo = accessor(b)

        if (typeof ao === 'undefined') {
          if (typeof bo === 'undefined') {
            continue
          }
          return 1
        }

        if (ao === bo) {
          continue
        }

        return ao > bo ? 1 : -1
      }

      return ai - bi
    })
    .map(([d]) => d)
}

function capitalize(s: string) {
  if (typeof s !== 'string') return ''
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function removeUnderscores(s?: string) {
  return s?.replace(/(^_|_$)/, '').replace(/(\/_|_\/)/, '/')
}

function removeTrailingUnderscores(s?: string) {
  return s?.replace(/(_$)/, '').replace(/(_\/)/, '/')
}

function replaceBackslash(s: string) {
  return s.replace(/\\/gi, '/')
}

export function hasParentRoute(
  routes: RouteNode[],
  routePathToCheck: string | undefined,
): RouteNode | null {
  if (!routePathToCheck || routePathToCheck === '/') {
    return null
  }

  const sortedNodes = multiSortBy(routes, [
    (d) => d.routePath!.length * -1,
    (d) => d.variableName,
  ]).filter((d) => d.routePath !== `/${rootPathId}`)

  for (const route of sortedNodes) {
    if (route.routePath === '/') continue

    if (
      routePathToCheck.startsWith(`${route.routePath}/`) &&
      route.routePath !== routePathToCheck
    ) {
      return route
    }
  }
  const segments = routePathToCheck.split('/')
  segments.pop() // Remove the last segment
  const parentRoutePath = segments.join('/')

  return hasParentRoute(routes, parentRoutePath)
}
