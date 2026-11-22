# NOVIX TV Converter

Private-purpose conversion API for NOVIX TV. The service downloads an existing video object from Filebase, converts it to MP4 H.264/AAC with FFmpeg, and uploads the converted file back to Filebase.

## Deploy on Render

Create a new **Web Service** from this repository and select the **Docker** runtime.

Set these environment variables in Render:

- `FILEBASE_ACCESS_KEY_ID`
- `FILEBASE_SECRET_ACCESS_KEY`
- `FILEBASE_BUCKET` (currently `novix-tv`)
- `FILEBASE_ENDPOINT` (currently `https://s3.filebase.io`)
- `FILEBASE_REGION` (use the same signing region as the existing NOVIX TV Filebase client)
- `CONVERTER_API_TOKEN` (generate a long random secret; it must also be configured in the main NOVIX TV backend)
- `MAX_INPUT_BYTES` (optional, defaults to 2147483648)

Set the health check path to `/health`.

## API

### Health

`GET /health`

### Convert

`POST /convert`

Header:

`Authorization: Bearer <CONVERTER_API_TOKEN>`

JSON body:

```json
{
  "key": "videos/original-video.mp4",
  "filename": "original-video.mp4"
}
```

Successful response:

```json
{
  "status": "completed",
  "key": "videos/converted/<generated-name>.mp4",
  "contentType": "video/mp4",
  "size": 123456,
  "duration": 123.45
}
```

The API accepts object keys, not public URLs or uploaded file bodies. Keep all credentials in Render environment variables, never in this repository.

## Resource note

This service processes one conversion at a time and uses a single FFmpeg thread with the ultrafast preset. Render's free instance still has limited RAM, CPU, disk, and monthly instance hours; moving conversion to a second free service does not remove those limits.
