export const CONFIG_ENV_NAMES = ["EASYCODE_API_KEY", "EASYCODE_BASE_URL", "EASYCODE_MODEL"] as const;

export interface EasyCodeConfig {
  readonly apiKey: string;
  readonly baseUrl: URL;
  readonly model: string;
}
