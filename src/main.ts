import { functionStateServerCallFunctionRequest } from '@v3rt3p/types/function-state-server'
import dotenv from 'dotenv'
import express from 'express'
import mqtt, { MqttClient } from 'mqtt'
import fs from 'node:fs'
import { parse } from 'yaml'
import z from 'zod'

import {
  StatefulMQTTFunctionProvider,
  configValidator as statefulMqttFunctionProviderConfigValidator
} from './function-provider/stateful-mqtt'
import {
  StatelessMQTTFunctionProvider,
  configValidator as statelessMqttFunctionProviderConfigValidator
} from './function-provider/stateless-mqtt'
import { FunctionProvider } from './function-provider/types'
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

dotenv.config({
  path: '.env.local'
})
dotenv.config()

const PORT = Number.parseInt(process.env.PORT || '8080')

const MQTT_URL = process.env.MQTT_URL ?? 'mqtts://alice:alice@mqtt.svc.bksp.in:8883'
const MQTT_CA_CERTIFICATE_PATH = process.env.MQTT_CA_CERTIFICATE_PATH ?? 'ca-cert.pem'

const CONFIG_PATH = process.env.CONFIG_PATH ?? 'config.yaml'

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

const config = configType.parse(parse(fs.readFileSync(CONFIG_PATH).toString('utf8')))

const mqttClient = mqtt.connect(MQTT_URL, {
  ca: [fs.readFileSync(MQTT_CA_CERTIFICATE_PATH)]
})
mqttClient.on('connect', () => {
  logger.info('Connected to MQTT')
})
mqttClient.on('error', error => {
  logger.error('MQTT error: ', error)
})

const app = express()
app.use(express.json())

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

app.put('/state', (_, response) => {
  response.status(200).json({})
})

app.post('/state', (_, response) => {
  (async () => {
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
    response.status(200).json(Object.fromEntries(await Promise.all(promises)))
  })().catch((error) => {
    response.status(500).json({
      error: error.toString()
    })
  })
})

app.get('/functions', (_, response) => {
  response.status(200).json(Object.fromEntries(Object.entries(functionProviders)
    .map(([name, provider]) => {
      return [name, {
        arguments: provider.getArguments(),
        description: provider.getDescription()
      }]
    })))
})

app.patch('/functions', (request, response) => {
  const body = functionStateServerCallFunctionRequest.parse(request.body)
  const calledFunction = functionProviders[body.name]
  logger.info(`Called function '${body.name}' with ${JSON.stringify(body)}`)
  if (!calledFunction) {
    response.status(500).json({
      error: 'No such function exists'
    })
    return
  }
  calledFunction.invoke(body.arguments)
    .then(() => {
      response.status(200).json({})
    })
    .catch(error => {
      response.status(500).json({
        error: error.toString()
      })
    })
})

app.listen(PORT, error => {
  if (error) {
    logger.fatal(`Failed to start on :${PORT}: ${error}`)
    return
  }
  logger.info(`Started on :${PORT}`)
})
