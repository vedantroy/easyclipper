import { useMemo, useState } from 'react'
import { useDropzone } from 'react-dropzone'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { hashFile } from '@/lib/hash-file'

type UploadScreenProps = {
  onFileAccepted: (file: File, hash: string) => void | Promise<void>
  // isBusy?: boolean
}

export function UploadScreen({ onFileAccepted }: UploadScreenProps) {
  const [isHashing, setIsHashing] = useState(false)

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    disabled: isHashing,
    multiple: false,
    accept: {
      'audio/*': [],
      'video/*': []
    },
    onDropAccepted: async (acceptedFiles) => {
      const [file] = acceptedFiles
      if (file) {
        try {
          setIsHashing(true)
          const hash = await hashFile(file)
          await onFileAccepted(file, hash)
        } catch (error) {
          console.error('Failed to hash file before upload:', error)
        } finally {
          setIsHashing(false)
        }
      }
    }
  })

  const dropzoneLabel = useMemo(() => {
    if (isDragReject) {
      return 'Unsupported file type'
    }

    if (isHashing) {
      return 'Preparing file...'
    }

    if (isDragActive) {
      return 'Drop the file to start'
    }

    return 'Drag & drop your audio or video file here'
  }, [isDragActive, isDragReject, isHashing])

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-xl border-dashed border-muted-foreground/40 bg-card/60 shadow-lg backdrop-blur">
        <CardHeader className="space-y-1 text-center">
          <CardTitle className="text-2xl font-semibold tracking-tight">
            Upload to Start
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            We&apos;ll transcribe your media right in the browser.
          </p>
        </CardHeader>
        <CardContent>
          <div
            {...getRootProps()}
            className={cn(
              'group relative flex h-56 flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed border-muted transition',
              'bg-muted/20 hover:border-primary/60 hover:bg-muted/40',
              isDragActive && 'border-primary/80 bg-primary/10',
              isDragReject && 'border-destructive/60 bg-destructive/10',
              isHashing && 'pointer-events-none opacity-60'
            )}
          >
            <input {...getInputProps()} aria-label="Upload media" />

            <div className="flex flex-col items-center gap-2 text-center">
              <span className="text-base font-medium text-foreground">{dropzoneLabel}</span>
              <span className="text-xs text-muted-foreground">
                {isHashing ? 'Hashing file so we can resume later' : 'Click to browse files from your device'}
              </span>
            </div>

            {/* <Button
              type="button"
              variant="outline"
              className="pointer-events-none px-6"
            >
              Select file
            </Button> */}
          </div>

          <p className="mt-6 text-center text-xs leading-relaxed text-muted-foreground">
            Processing happens locally, so your files never leave the browser.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
