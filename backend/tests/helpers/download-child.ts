import { downloadUrl } from "@/lib/download";

const url = process.env.MAIPAI_DOWNLOAD_TEST_URL;
const destination = process.env.MAIPAI_DOWNLOAD_TEST_DESTINATION;
const digest = process.env.MAIPAI_DOWNLOAD_TEST_SHA256;
if (!url || !destination || !digest) throw new Error("Download child needs its test URL, destination and checksum.");
await downloadUrl(url, destination, { expectedSha256: digest, expectedBytes: Number(process.env.MAIPAI_DOWNLOAD_TEST_BYTES) });
