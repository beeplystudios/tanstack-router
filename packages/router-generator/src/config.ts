import path from 'path'
import { readFileSync, existsSync } from 'fs'
import { z } from 'zod'

export const configSchema = z.object({
  routeFilePrefix: z.string().optional(),
  routeFileIgnorePrefix: z.string().optional().default('-'),
  routesDirectory: z.string().optional().default('./src/routes'),
  generatedRouteTree: z.string().optional().default('./src/routeTree.gen.ts'),
  quoteStyle: z.enum(['single', 'double']).optional().default('single'),
  disableTypes: z.boolean().optional().default(false),
})

export type Config = z.infer<typeof configSchema>

const configFilePathJson = path.resolve(process.cwd(), 'tsr.config.json')

export async function getConfig(): Promise<Config> {
  const exists = existsSync(configFilePathJson)

  let config: Config

  if (exists) {
    config = configSchema.parse(
      JSON.parse(readFileSync(configFilePathJson, 'utf-8')),
    )
  } else {
    config = configSchema.parse({})
  }

  // If typescript is disabled, make sure the generated route tree is a .js file
  if (config.disableTypes) {
    config.generatedRouteTree = config.generatedRouteTree.replace(
      /\.(ts|tsx)$/,
      '.js',
    )
  }

  return config
}
