import * as React from 'react'
import invariant from 'tiny-invariant'
import warning from 'tiny-warning'
import { CatchBoundary, ErrorComponent } from './CatchBoundary'
import { useRouter, useRouterState } from './RouterProvider'
import { ResolveRelativePath, ToOptions } from './link'
import { AnyRoute, ReactNode, RootRoute, rootRouteId } from './route'
import {
  FullSearchSchema,
  ParseRoute,
  RouteById,
  RouteByPath,
  RouteIds,
  RoutePaths,
} from './routeInfo'
import {
  RegisteredRouter,
  RouterState,
  throwGlobalNotFoundRouteId,
} from './router'
import { NoInfer, StrictOrFrom, pick } from './utils'
import { CatchNotFound, isNotFound, notFound } from './not-found'

export const matchContext = React.createContext<string | undefined>(undefined)

export interface RouteMatch<
  TRouteTree extends AnyRoute = AnyRoute,
  TRouteId extends RouteIds<TRouteTree> = ParseRoute<TRouteTree>['id'],
> {
  id: string
  routeId: TRouteId
  pathname: string
  params: RouteById<TRouteTree, TRouteId>['types']['allParams']
  status: 'pending' | 'success' | 'error'
  isFetching: boolean
  showPending: boolean
  error: unknown
  paramsError: unknown
  searchError: unknown
  updatedAt: number
  loadPromise?: Promise<void>
  loaderData?: RouteById<TRouteTree, TRouteId>['types']['loaderData']
  routeContext: RouteById<TRouteTree, TRouteId>['types']['routeContext']
  context: RouteById<TRouteTree, TRouteId>['types']['allContext']
  search: FullSearchSchema<TRouteTree> &
    RouteById<TRouteTree, TRouteId>['types']['fullSearchSchema']
  fetchCount: number
  abortController: AbortController
  cause: 'preload' | 'enter' | 'stay'
  loaderDeps: RouteById<TRouteTree, TRouteId>['types']['loaderDeps']
  preload: boolean
  invalid: boolean
  pendingPromise?: Promise<void>
}

export type AnyRouteMatch = RouteMatch<any, any>

export function Matches() {
  const router = useRouter()
  const matchId = useRouterState({
    select: (s) => {
      return getRenderedMatches(s)[0]?.id
    },
  })

  return (
    <matchContext.Provider value={matchId}>
      <CatchBoundary
        getResetKey={() => router.state.resolvedLocation.state?.key}
        errorComponent={ErrorComponent}
        onCatch={() => {
          warning(
            false,
            `Error in router! Consider setting an 'errorComponent' in your RootRoute! 👍`,
          )
        }}
      >
        {matchId ? <Match matchId={matchId} /> : null}
      </CatchBoundary>
    </matchContext.Provider>
  )
}

function SafeFragment(props: any) {
  return <>{props.children}</>
}

export function Match({ matchId }: { matchId: string }) {
  const router = useRouter()
  const { routeId, hasNotFound: hasGlobalNotFound } = useRouterState({
    select: (s) => ({
      routeId: getRenderedMatches(s).find((d) => d.id === matchId)
        ?.routeId as string,
      hasNotFound: getRenderedMatches(s).some(
        (m) => m.routeId === throwGlobalNotFoundRouteId,
      ),
    }),
  })

  invariant(
    routeId,
    `Could not find routeId for matchId "${matchId}". Please file an issue!`,
  )

  const route = router.routesById[routeId]!

  // If a global not-found (a not found match that happens during path matching) is found,
  // throw it up the tree to be handled by the root route.
  if (hasGlobalNotFound && routeId !== rootRouteId) {
    throw notFound({ global: true })
  }

  const PendingComponent = (route.options.pendingComponent ??
    router.options.defaultPendingComponent) as any

  const pendingElement = PendingComponent ? <PendingComponent /> : null

  const routeErrorComponent =
    route.options.errorComponent ??
    router.options.defaultErrorComponent ??
    ErrorComponent

  const routeNotFoundComponent = route.isRoot
    ? // If it's the root route, use the globalNotFound option, with fallback to the notFoundRoute's component
      route.options.notFoundComponent ??
      router.options.notFoundRoute?.options.component
    : route.options.notFoundComponent

  const ResolvedSuspenseBoundary =
    route.options.wrapInSuspense ??
    PendingComponent ??
    route.options.component?.preload ??
    route.options.pendingComponent?.preload ??
    (route.options.errorComponent as any)?.preload
      ? React.Suspense
      : SafeFragment

  const ResolvedCatchBoundary = routeErrorComponent
    ? CatchBoundary
    : SafeFragment

  const ResolvedNotFoundBoundary = routeNotFoundComponent
    ? CatchNotFound
    : SafeFragment

  return (
    <matchContext.Provider value={matchId}>
      <ResolvedSuspenseBoundary fallback={pendingElement}>
        <ResolvedCatchBoundary
          getResetKey={() => router.state.resolvedLocation.state?.key}
          errorComponent={routeErrorComponent}
          onCatch={(error) => {
            // Forward not found errors (we don't want to show the error component for these)
            if (isNotFound(error)) throw error
            warning(false, `Error in route match: ${matchId}`)
          }}
        >
          <ResolvedNotFoundBoundary
            fallback={(error) => {
              // If the current not found handler doesn't exist or doesn't handle global not founds, forward it up the tree
              if (!routeNotFoundComponent || (error.global && !route.isRoot))
                throw error

              return React.createElement(routeNotFoundComponent, {
                data: error.data,
              })
            }}
          >
            <MatchInner matchId={matchId!} pendingElement={pendingElement} />
          </ResolvedNotFoundBoundary>
        </ResolvedCatchBoundary>
      </ResolvedSuspenseBoundary>
    </matchContext.Provider>
  )
}

function MatchInner({
  matchId,
  pendingElement,
}: {
  matchId: string
  pendingElement: any
}): any {
  const router = useRouter()
  const routeId = useRouterState({
    select: (s) =>
      getRenderedMatches(s).find((d) => d.id === matchId)?.routeId as string,
  })

  const route = router.routesById[routeId]!

  const match = useRouterState({
    select: (s) =>
      pick(getRenderedMatches(s).find((d) => d.id === matchId)!, [
        'status',
        'error',
        'showPending',
        'loadPromise',
      ]),
  })

  if (match.status === 'error') {
    throw match.error
  }

  if (match.status === 'pending') {
    if (match.showPending) {
      return pendingElement
    }
    throw match.loadPromise
  }

  if (match.status === 'success') {
    let Comp = route.options.component ?? router.options.defaultComponent

    if (Comp) {
      return <Comp />
    }

    return <Outlet />
  }

  invariant(
    false,
    'Idle routeMatch status encountered during rendering! You should never see this. File an issue!',
  )
}

export const Outlet = React.memo(function Outlet() {
  const matchId = React.useContext(matchContext)

  const childMatchId = useRouterState({
    select: (s) => {
      const matches = getRenderedMatches(s)
      const index = matches.findIndex((d) => d.id === matchId)
      return matches[index + 1]?.id
    },
  })

  if (!childMatchId) {
    return null
  }

  return <Match matchId={childMatchId} />
})

export interface MatchRouteOptions {
  pending?: boolean
  caseSensitive?: boolean
  includeSearch?: boolean
  fuzzy?: boolean
}

export type UseMatchRouteOptions<
  TRouteTree extends AnyRoute = RegisteredRouter['routeTree'],
  TFrom extends RoutePaths<TRouteTree> = '/',
  TTo extends string = '',
  TMaskFrom extends RoutePaths<TRouteTree> = '/',
  TMaskTo extends string = '',
> = ToOptions<TRouteTree, TFrom, TTo, TMaskFrom, TMaskTo> & MatchRouteOptions

export function useMatchRoute<
  TRouteTree extends AnyRoute = RegisteredRouter['routeTree'],
>() {
  useRouterState({ select: (s) => [s.location, s.resolvedLocation] })
  const { matchRoute } = useRouter()

  return React.useCallback(
    <
      TFrom extends RoutePaths<TRouteTree> = '/',
      TTo extends string = '',
      TMaskFrom extends RoutePaths<TRouteTree> = '/',
      TMaskTo extends string = '',
      TResolved extends string = ResolveRelativePath<TFrom, NoInfer<TTo>>,
    >(
      opts: UseMatchRouteOptions<TRouteTree, TFrom, TTo, TMaskFrom, TMaskTo>,
    ): false | RouteById<TRouteTree, TResolved>['types']['allParams'] => {
      const { pending, caseSensitive, fuzzy, includeSearch, ...rest } = opts

      return matchRoute(rest as any, {
        pending,
        caseSensitive,
        fuzzy,
        includeSearch,
      })
    },
    [],
  )
}

export type MakeMatchRouteOptions<
  TRouteTree extends AnyRoute = RegisteredRouter['routeTree'],
  TFrom extends RoutePaths<TRouteTree> = '/',
  TTo extends string = '',
  TMaskFrom extends RoutePaths<TRouteTree> = '/',
  TMaskTo extends string = '',
> = ToOptions<TRouteTree, TFrom, TTo, TMaskFrom, TMaskTo> &
  MatchRouteOptions & {
    // If a function is passed as a child, it will be given the `isActive` boolean to aid in further styling on the element it returns
    children?:
      | ((
          params?: RouteByPath<
            TRouteTree,
            ResolveRelativePath<TFrom, NoInfer<TTo>>
          >['types']['allParams'],
        ) => ReactNode)
      | React.ReactNode
  }

export function MatchRoute<
  TRouteTree extends AnyRoute = RegisteredRouter['routeTree'],
  TFrom extends RoutePaths<TRouteTree> = '/',
  TTo extends string = '',
  TMaskFrom extends RoutePaths<TRouteTree> = '/',
  TMaskTo extends string = '',
>(
  props: MakeMatchRouteOptions<TRouteTree, TFrom, TTo, TMaskFrom, TMaskTo>,
): any {
  const matchRoute = useMatchRoute()
  const params = matchRoute(props as any)

  if (typeof props.children === 'function') {
    return (props.children as any)(params)
  }

  return !!params ? props.children : null
}

export function getRenderedMatches(state: RouterState) {
  return state.pendingMatches?.some((d) => d.showPending)
    ? state.pendingMatches
    : state.matches
}

export function useMatch<
  TRouteTree extends AnyRoute = RegisteredRouter['routeTree'],
  TFrom extends RouteIds<TRouteTree> = RouteIds<TRouteTree>,
  TStrict extends boolean = true,
  TRouteMatchState = RouteMatch<TRouteTree, TFrom>,
  TSelected = TRouteMatchState,
>(
  opts: StrictOrFrom<TFrom> & {
    select?: (match: TRouteMatchState) => TSelected
  },
): TStrict extends true ? TSelected : TSelected | undefined {
  const router = useRouter()
  const nearestMatchId = React.useContext(matchContext)

  const nearestMatchRouteId = getRenderedMatches(router.state).find(
    (d) => d.id === nearestMatchId,
  )?.routeId

  const matchRouteId = (() => {
    const matches = getRenderedMatches(router.state)
    const match = opts?.from
      ? matches.find((d) => d.routeId === opts?.from)
      : matches.find((d) => d.id === nearestMatchId)
    return match!.routeId
  })()

  if (opts?.strict ?? true) {
    invariant(
      nearestMatchRouteId == matchRouteId,
      `useMatch("${
        matchRouteId as string
      }") is being called in a component that is meant to render the '${nearestMatchRouteId}' route. Did you mean to 'useMatch("${
        matchRouteId as string
      }", { strict: false })' or 'useRoute("${
        matchRouteId as string
      }")' instead?`,
    )
  }

  const matchSelection = useRouterState({
    select: (state) => {
      const match = getRenderedMatches(state).find(
        (d) => d.id === nearestMatchId,
      )

      invariant(
        match,
        `Could not find ${
          opts?.from
            ? `an active match from "${opts.from}"`
            : 'a nearest match!'
        }`,
      )

      return opts?.select ? opts.select(match as any) : match
    },
  })

  return matchSelection as any
}

export function useMatches<T = RouteMatch[]>(opts?: {
  select?: (matches: RouteMatch[]) => T
}): T {
  return useRouterState({
    select: (state) => {
      let matches = getRenderedMatches(state)
      return opts?.select ? opts.select(matches) : (matches as T)
    },
  })
}

export function useParentMatches<T = RouteMatch[]>(opts?: {
  select?: (matches: RouteMatch[]) => T
}): T {
  const contextMatchId = React.useContext(matchContext)

  return useMatches({
    select: (matches) => {
      matches = matches.slice(matches.findIndex((d) => d.id === contextMatchId))
      return opts?.select ? opts.select(matches) : (matches as T)
    },
  })
}

export function useLoaderDeps<
  TRouteTree extends AnyRoute = RegisteredRouter['routeTree'],
  TFrom extends RouteIds<TRouteTree> = RouteIds<TRouteTree>,
  TStrict extends boolean = true,
  TRouteMatch extends RouteMatch<TRouteTree, TFrom> = RouteMatch<
    TRouteTree,
    TFrom
  >,
  TSelected = Required<TRouteMatch>['loaderDeps'],
>(
  opts: StrictOrFrom<TFrom> & {
    select?: (match: TRouteMatch) => TSelected
  },
): TStrict extends true ? TSelected : TSelected | undefined {
  return useMatch({
    ...opts,
    select: (s) => {
      return typeof opts.select === 'function'
        ? opts.select(s?.loaderDeps)
        : s?.loaderDeps
    },
  })!
}

export function useLoaderData<
  TRouteTree extends AnyRoute = RegisteredRouter['routeTree'],
  TFrom extends RouteIds<TRouteTree> = RouteIds<TRouteTree>,
  TStrict extends boolean = true,
  TRouteMatch extends RouteMatch<TRouteTree, TFrom> = RouteMatch<
    TRouteTree,
    TFrom
  >,
  TSelected = Required<TRouteMatch>['loaderData'],
>(
  opts: StrictOrFrom<TFrom> & {
    select?: (match: TRouteMatch) => TSelected
  },
): TStrict extends true ? TSelected : TSelected | undefined {
  return useMatch({
    ...opts,
    select: (s) => {
      return typeof opts.select === 'function'
        ? opts.select(s?.loaderData)
        : s?.loaderData
    },
  })!
}
