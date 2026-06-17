# frozen_string_literal: true

require "uri"

module Backlex
  # File operations against /api/storage.
  class Storage
    def initialize(client)
      @client = client
    end

    # List stored objects, optionally filtered by key prefix.
    def list(prefix = nil)
      path = "/api/storage"
      path += "?prefix=#{URI.encode_www_form_component(prefix)}" if prefix && !prefix.empty?
      @client.request("GET", path)["data"]
    end

    # Upload bytes under +key+. Pass content_type/folder_id nil to omit them.
    def put(key, body, content_type: nil, folder_id: nil)
      path = "/api/storage/#{URI.encode_www_form_component(key)}"
      path += "?folderId=#{URI.encode_www_form_component(folder_id)}" if folder_id
      @client.put_raw(path, body, content_type)
    end

    # Fetch the raw bytes for +key+.
    def download(key)
      @client.get_raw("/api/storage/#{URI.encode_www_form_component(key)}")
    end

    # Remove the object at +key+.
    def delete(key)
      @client.request("DELETE", "/api/storage/#{URI.encode_www_form_component(key)}")
    end
  end
end
