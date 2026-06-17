# frozen_string_literal: true

require "net/http"
require "uri"
require "json"

module Backlex
  # Handle for an active realtime subscription. #close unsubscribes — the same
  # contract as the TS SDK's returned unsubscribe function. The reader runs on a
  # background thread and auto-reconnects on a dropped stream (3s back-off),
  # replaying via Last-Event-ID.
  class Subscription
    def initialize(client, url, on_event, on_error)
      @stopped = false
      @thread = Thread.new { run(client, url, on_event, on_error) }
    end

    def close
      @stopped = true
      @thread&.kill
    end

    private

    def run(client, url, on_event, on_error)
      last_id = nil
      until @stopped
        begin
          uri = URI(url)
          Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https") do |http|
            req = Net::HTTP::Get.new(uri)
            req["Accept"] = "text/event-stream"
            client.auth_header(req)
            req["Last-Event-ID"] = last_id if last_id
            http.request(req) do |res|
              if res.code.to_i != 200
                on_error&.call(Backlex::Error.new(res.code.to_i, "UNKNOWN", "HTTP #{res.code}"))
                next
              end
              last_id = read_stream(res, on_event, on_error, last_id)
            end
          end
        rescue StandardError => e
          on_error&.call(e) unless @stopped
        end
        break if @stopped

        sleep 3
      end
    end

    # Parse the SSE byte stream, buffering across chunk boundaries.
    def read_stream(res, on_event, on_error, last_id)
      buffer = +""
      data = []
      res.read_body do |chunk|
        break if @stopped

        buffer << chunk
        while (idx = buffer.index("\n"))
          line = buffer.slice!(0, idx + 1).chomp
          if line.empty?
            unless data.empty?
              payload = data.join("\n")
              data = []
              begin
                on_event.call(JSON.parse(payload))
              rescue StandardError => e
                on_error&.call(e)
              end
            end
          elsif line.start_with?(":")
            # comment / heartbeat
          elsif line.start_with?("id:")
            last_id = line[3..].strip
          elsif line.start_with?("data:")
            d = line[5..]
            d = d[1..] if d.start_with?(" ")
            data << d
          end
        end
      end
      last_id
    end
  end
end
