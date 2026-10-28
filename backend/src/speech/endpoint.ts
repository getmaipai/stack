// POST /v1/audio/endpoint: has the speaker finished their turn? The model is
// Smart Turn v3.2, an installed component of the `stt` role (DUPLEX-02).
import { componentModel } from "@/lib/supervisor";
import { decodeWave, toRecognizerRate } from "@/speech/audio";
import { smartTurnProbability } from "@/speech/smartTurn";

export class EndpointModelMissingError extends Error {
  constructor() {
    super("The end-of-turn model is not installed on this Stack yet.");
    this.name = "EndpointModelMissingError";
  }
}

/** The spec's SttEndpointResponse for one WAV (the utterance so far). */
export async function scoreEndpoint(wav: Uint8Array): Promise<{ complete: boolean; probability: number }> {
  const model = componentModel("stt", "endpoint");
  if (!model?.modelPath) throw new EndpointModelMissingError();
  const samples = toRecognizerRate(decodeWave(wav));
  const probability = await smartTurnProbability(model.modelPath, samples);
  return { complete: probability > 0.5, probability };
}
