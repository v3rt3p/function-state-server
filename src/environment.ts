import dotenv from 'dotenv'
import z from 'zod'

dotenv.config({
  path: '.env.local'
})
dotenv.config()

const environmentType = z.object({
  CONFIG_PATH: z.string().default('config.yaml'),
  MQTT_CA_CERTIFICATE_PATH: z.string().default('ca-cert.pem'),
  MQTT_URL: z.url(),
  PORT: z.string().transform(Number).default(8080)
})

export function getEnvironment (): z.infer<typeof environmentType> {
  return environmentType.parse(process.env)
}
