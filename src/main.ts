import node from '@elysia/node'
import openapi from '@elysia/openapi'
import { functions, functionStateServerCallFunctionRequest, functionStateServerCallFunctionResponse, functionStateServerGetDependantFunctionsRequest, functionStateServerGetDependantStateRequest, functionStateServerStateResponse } from '@v3rt3p/types/function-state-server'
import Elysia from 'elysia'
import mqtt, { MqttClient } from 'mqtt'
import fs from 'node:fs'
import { parse } from 'yaml'
import z from 'zod'

import { getEnvironment } from './environment'
import {
  StatefulMQTTFunctionProvider,
  configValidator as statefulMqttFunctionProviderConfigValidator
} from './function-provider/stateful-mqtt'
import {
  StatelessMQTTFunctionProvider,
  configValidator as statelessMqttFunctionProviderConfigValidator
} from './function-provider/stateless-mqtt'
import { FunctionArgument, FunctionProvider } from './function-provider/types'
import { getLogger } from './logger'
import {
  MoonrakerStatusStateProvider,
  configValidator as moonrakerStatusStateProviderConfigValidator
} from './state-provider/moonraker-status'
import { MQTTStateProvider, configValidator as mqttStateProviderConfigValidator } from './state-provider/mqtt'
import { StateProvider } from './state-provider/types'
import {
  YncaNowPlayingStateProvider,
  configValidator as yncaNowPlayingStateProviderConfigValidator
} from './state-provider/ynca-now-playing'

const logger = getLogger()

const environment = getEnvironment()

interface AllDependencies {
  mqtt: MqttClient;
}

const stateProviderFactories: Record<string, [z.ZodType,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (config: any, dependencies: AllDependencies) => StateProvider]> = {
    'moonraker-status': [moonrakerStatusStateProviderConfigValidator, MoonrakerStatusStateProvider.create],
    mqtt: [mqttStateProviderConfigValidator, MQTTStateProvider.create],
    'ynca-now-playing': [yncaNowPlayingStateProviderConfigValidator, YncaNowPlayingStateProvider.create]
  }

const functionProviderFactories: Record<string, [z.ZodType,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (config: any, dependencies: AllDependencies) => FunctionProvider]> = {
    'stateful-mqtt': [statefulMqttFunctionProviderConfigValidator, StatefulMQTTFunctionProvider.create],
    'stateless-mqtt': [statelessMqttFunctionProviderConfigValidator, StatelessMQTTFunctionProvider.create]
  }

const stateProviderConfigs = z.union(Object.entries(stateProviderFactories).map((
  [key, [configValidator]]) => {
  return z.intersection(z.object({
    type: z.literal(key)
  }), configValidator)
}))

const functionProviderConfigs = z.union(Object.entries(functionProviderFactories).map((
  [key, [configValidator]]) => {
  return z.intersection(z.object({
    type: z.literal(key)
  }), configValidator)
}))

const configType = z.object({
  functionProviders: z.record(z.string(), functionProviderConfigs),
  stateProviders: z.record(z.string(), stateProviderConfigs)
})

const config = configType.parse(parse(fs.readFileSync(environment.CONFIG_PATH).toString('utf8')))

const mqttClient = mqtt.connect(environment.MQTT_URL, {
  ca: [fs.readFileSync(environment.MQTT_CA_CERTIFICATE_PATH)]
})
mqttClient.on('connect', () => {
  logger.info('Connected to MQTT')
})
mqttClient.on('error', error => {
  logger.error('MQTT error: ', error)
})

const dependencies: AllDependencies = {
  mqtt: mqttClient
}

const stateProviders: Record<string, StateProvider> = {}
for (const [name, providerConfig] of Object.entries(config.stateProviders)) {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const [configValidator, factory] = stateProviderFactories[providerConfig.type]!
  stateProviders[name] = factory({
    ...(configValidator.parse(providerConfig) as object),
    name
  }, dependencies)
  logger.info(`Registered '${name}' state provider`)
}

const functionProviders: Record<string, FunctionProvider> = {}
for (const [name, providerConfig] of Object.entries(config.functionProviders)) {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const [configValidator, factory] = functionProviderFactories[providerConfig.type]!
  functionProviders[name] = factory({
    ...(configValidator.parse(providerConfig) as object),
    name
  }, dependencies)
  logger.info(`Registered '${name}' function provider`)
}

const internalErrorType = z.object({
  code: z.literal('INTERNAL_SERVER_ERROR'),
  text: z.string().optional().describe('Optional error text')
})

const functionNotFoundErrorType = z.object({
  code: z.literal('FUNCTION_NOT_FOUND')
})

const app = new Elysia({
  adapter: node()
}).use(openapi({
  documentation: {
    info: {
      title: 'Function-state-server API',
      version: '1.4.6'
    }
  },
  mapJsonSchema: {
    zod: z.toJSONSchema
  }
}))
  .guard({
    response: {
      500: internalErrorType
    }
  })
  .onError(async ({ error, status }) => {
    status(500, {
      code: 'INTERNAL_SERVER_ERROR',
      text: String(error)
    })
  })

app.get('/state', async () => {
  return {}
}, {
  detail: {
    summary: 'Get independent state',
    tags: ['state']
  },
  response: {
    200: functionStateServerStateResponse
  }
})

app.put('/state', async () => {
  const promises: Promise<[string, {
    description: string,
    value: string;
  }]>[] = []
  for (const [name, provider] of Object.entries(stateProviders)) {
    promises.push((async () => {
      try {
        const result = await provider.getValue()
        return [name, {
          description: provider.getDescription(),
          value: result
        }]
      } catch (error) {
        logger.warn(`Failed to get '${name}' state: ${error}`)
        return [name, {
          description: provider.getDescription(),
          value: 'not available'
        }]
      }
    })())
  }
  return Object.fromEntries(await Promise.all(promises))
}, {
  body: functionStateServerGetDependantStateRequest,
  detail: {
    summary: 'Get dependent state',
    tags: ['state']
  },
  response: {
    200: functionStateServerStateResponse
  }
})

function convertArgumentsToZodType (argumentsInfo: Record<string, FunctionArgument>): z.ZodType {
  const types: Record<string, z.ZodSchema> = {}
  for (const [key, value] of Object.entries(argumentsInfo)) {
    types[key] = convertArgumentToZodType(value)
  }
  return Object.keys(types).length === 0 ? z.object({}) : z.object(types)
}

function convertArgumentToZodType (type: FunctionArgument): z.ZodType {
  switch (type.constraints.type) {
    case 'number-min-max': {
      return z.number().min(type.constraints.min).max(type.constraints.max).describe(type.description)
    }
    case 'number-variants': {
      return z.union(type.constraints.variants.map(variant =>
        z.literal(variant.value).describe(variant.description))).describe(type.description)
    }
  }
}

app.get('/functions', async () => {
  return Object.fromEntries(Object.entries(functionProviders)
    .map(([name, provider]) => {
      return [name, {
        arguments: convertArgumentsToZodType(provider.getArguments()),
        description: provider.getDescription(),
        hasResponse: false
      }]
    }))
}, {
  detail: {
    summary: 'Get independent functions',
    tags: ['functions']
  },
  response: {
    200: functions
  }
})

app.put('/functions', async () => {
  return {}
}, {
  body: functionStateServerGetDependantFunctionsRequest,
  detail: {
    summary: 'Get dependent functions',
    tags: ['functions']
  },
  response: {
    200: functions
  }
})

app.post('/functions', async ({ body, status }) => {
  const calledFunction = functionProviders[body.name]
  logger.info(`Called function '${body.name}' with ${JSON.stringify(body)}`)

  if (!calledFunction) {
    return status(404, {
      code: 'FUNCTION_NOT_FOUND'
    })
  }

  await calledFunction.invoke(body.arguments)

  return {}
}, {
  body: functionStateServerCallFunctionRequest,
  detail: {
    summary: 'Call function',
    tags: ['functions']
  },
  response: {
    200: functionStateServerCallFunctionResponse,
    404: functionNotFoundErrorType
  }
})

try {
  app.listen(environment.PORT, () => {
    logger.info(`Started function-state-server on :${environment.PORT}`)
  })
} catch (error) {
  logger.error(`function-state-server failed to start on :${environment.PORT}: ${error}`)
}

process.removeAllListeners('SIGINT')

process.on('SIGINT', () => {
  logger.info('Stopping...')
  if (app.server) {
    app.stop()
  }
  logger.info('Stopped')
})
