# syntax=docker/dockerfile:1
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/adserver ./cmd/adserver \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/loadgen ./cmd/loadgen

# Distroless: no shell or package manager, only the static binary.
FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/adserver /out/loadgen /
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/adserver"]
