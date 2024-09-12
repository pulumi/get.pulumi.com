#!/bin/bash

# A quick and dirty test script to check if a cdn matches the s3 bucket
# pass in a file with a list of object names to randomly compare them
# You can generate the file with something like:
#  aws s3 ls --recursive get.pulumi.com | awk '{ print $4 }' > objects.txt

OLD_URL="https://s3.us-west-2.amazonaws.com/get.pulumi.com"
NEW_URL="https://get.pulumi.com"

# Downloads a file in parts
function multi-curl() {
    url="$1"
    parts=5

    name="$2"
    size="$(curl --head --silent ${url} | grep -E "[Cc]ontent-[Ll]ength" | sed 's/[^0-9]*//g')"
    # echo Size: $size
    # echo Filename: $name
    # echo Downloading in $parts parts, c: $c

    if (( size < 5*1024*1024 )); then
        parts=1
    fi

    for (( c=1; c<=$parts; c++ ))
    do
        from="$(echo $[$size*($c-1)/$parts])"
        if [[ $c != $parts ]]; then
            to="$(echo $[($size*$c/$parts)-1])"
        else
            to="$(echo $[$size*$c/$parts])"
        fi

        out="$(printf 'temp.part'$c)"

        # echo "curl --silent --range $from-$to -o $out $url &"
        curl --silent --range $from-$to -o $out $url &

    done

    wait

    rm -f $name
    for (( c=1; c<=$parts; c++ ))
    do
        cat $(printf 'temp.part'$c) >> $name
        rm $(printf 'temp.part'$c)
    done
}

function cmpObjs() {
    object="$1"
    oldObject=$(echo $object | sed 's/\+/%2B/g')
    echo "$object: "
    case $((RANDOM % 5)) in
        0)
            # Simple fetch
            echo "  Simple fetch"
            curl --silent -o tmp.new "${NEW_URL}/$object" &
            curl --silent -o tmp.old "${OLD_URL}/$oldObject" &
            ;;
        1)
            # Fetch twice to ensure it's cached
            echo "  Fetch twice to ensure it's cached"
            curl --silent -o tmp.old "${OLD_URL}/$oldObject" &
            curl --silent "${NEW_URL}/$object" >/dev/null
            curl --silent -o tmp.new "${NEW_URL}/$object" &
            ;;
        2)
            # Fetch twice to ensure it's cached
            echo "  Multi-curl"
            ./multi-curl.sh "${OLD_URL}/$oldObject" tmp.old
            ./multi-curl.sh "${NEW_URL}/$object" tmp.new
            ;;
        3)
            # Fetch twice to ensure it's cached
            echo "  Cache after multi-curl"
            ./multi-curl.sh "${NEW_URL}/$object" tmp.new
            curl --silent -o tmp.new "${NEW_URL}/$object" &
            curl --silent -o tmp.old "${OLD_URL}/$oldObject" &
            ;;
        4)
            # Fetch twice to ensure it's cached
            echo "  Multi-curl after cache"
            curl --silent "${NEW_URL}/$object" >/dev/null
            ./multi-curl.sh "${NEW_URL}/$object" tmp.new &
            curl --silent -o tmp.old "${OLD_URL}/$oldObject" &
            ;;
        *)
            echo "Invalid option"
            ;;
    esac

    wait

    if diff -q tmp.new tmp.old; then
        printf "  \e[32mPASS\e[0m\n" # Green text for PASS
    else
        printf "  \e[31mFAIL\e[0m\n" # Red text for FAIL
        du -h tmp.new tmp.old
        exit 1
    fi
}

rm tmp.new tmp.old 2>/dev/null
rm tmp.part.* 2>/dev/null

while IFS= read -r object; do
    cmpObjs "$object"
done < <(shuf -r $1)
